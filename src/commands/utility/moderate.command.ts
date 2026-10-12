/**
 * /moderate (2.45.0, owner decision 3): pause one person's use of one TaruBot feature without
 * touching their Discord roles, lift a pause, and read what is paused. `block` and `lift` need
 * moderation.block, and `status` is for everyone: a person always reads their own pauses, and
 * another person's needs moderation.view. The router lets every member in, and each service call
 * checks its own permission, so no gate here can disagree with it.
 *
 * Feature and duration are fixed choices, so a typo can't pause the wrong thing; their values are
 * checked again below because Discord's choices are advice to the client, not part of the shape the
 * router verifies. Replies stay private even under DevBot's public-response override, because a
 * reply that names a paused member would tell onlookers about them.
 */
import { moderationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeMember, focusedOption } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { blockReply, liftReply, statusReply } from "../../discord/presenters/moderation.js";
import { userId } from "../../discord/selectors.js";
import {
  DEFAULT_PAUSE_DURATION,
  isPauseDuration,
  PAUSE_DURATIONS,
  PAUSE_FEATURE_IDS,
  PAUSE_FEATURES,
} from "../../domain/moderation.js";
import { can, requirePermission } from "../../domain/policy.js";
import { BLOCKABLE, MANAGER_ONLY_BLOCKS, type PermissionId } from "../../domain/rbac.js";
import { Failure } from "../../domain/values.js";

/** The feature choice that means every member feature. */
const ALL = "all";
const ALL_LABEL = "All member features";

/** The member features "all" pauses: everything pausable except what only a server manager pauses. */
const ALL_MEMBER_FEATURES: readonly PermissionId[] = BLOCKABLE.filter(
  (id) => !MANAGER_ONLY_BLOCKS.has(id),
);

/** The feature choices: each feature by its plain-words name, then "all". */
const FEATURE_CHOICES = [
  ...PAUSE_FEATURES.map(({ permission, label }) => ({ name: label, value: permission })),
  { name: ALL_LABEL, value: ALL },
];

/** The duration choices, shortest first, as PAUSE_DURATIONS lists them. */
const DURATION_CHOICES = Object.entries(PAUSE_DURATIONS).map(([value, { label }]) => ({
  name: label,
  value,
}));

const MEMBER = "Member: pick a suggestion or paste a user ID";

const data = command(
  "moderate",
  "Pause a member's use of a feature, lift a pause, or see what is paused",
)
  .addSubcommand((sub) =>
    sub
      .setName("block")
      .setDescription("Pause a member's use of one feature; their roles are untouched")
      .addStringOption(string("member", MEMBER, true, true))
      .addStringOption((option) =>
        option
          .setName("feature")
          .setDescription("What to pause. All member features leaves out mod mail")
          .setRequired(true)
          .addChoices(...FEATURE_CHOICES),
      )
      .addStringOption((option) =>
        option
          .setName("duration")
          .setDescription(
            `How long it lasts; the default is ${PAUSE_DURATIONS[DEFAULT_PAUSE_DURATION].label}`,
          )
          .setRequired(false)
          .addChoices(...DURATION_CHOICES),
      )
      .addStringOption(string("reason", "Why; the member will see this reason", true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("lift")
      .setDescription("End a pause early")
      .addStringOption(string("member", MEMBER, true, true))
      .addStringOption((option) =>
        option
          .setName("feature")
          .setDescription("What to lift. All member features lifts every pause you may lift")
          .setRequired(true)
          .addChoices(...FEATURE_CHOICES),
      )
      .addStringOption(string("reason", "Why; officers who can see pauses read it", true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription("See what is paused for you, or for a member if you are an officer")
      .addStringOption(
        string(
          "member",
          "Officers: the member to look up; pick a suggestion or paste a user ID",
          false,
          true,
        ),
      ),
  );

/** A feature choice as the permissions it names; anything else is the person's mistake. */
function permissionsOf(value: string, all: readonly PermissionId[]): readonly PermissionId[] {
  if (value === ALL) return all;
  const id = PAUSE_FEATURE_IDS.find((feature) => feature === value);
  if (id === undefined)
    throw new Failure("input", "Pick a feature from the list.", 0, {
      kind: "option",
      option: "feature",
    });
  return [id];
}

export default defineCommand({
  data,
  // No permissions: `status` is for everyone, and block and lift check moderation.block in the
  // service that does the work.
  requires: [moderationKey],
  alwaysPrivate: true,
  async execute({ actor, viewer, interaction, services }) {
    const moderation = services.get(moderationKey);
    const options = interaction.options;
    const sub = options.getSubcommand(true);
    if (sub === "status") {
      const subject = userId(options.getString("member") ?? actor.userId);
      // A member naming someone else is refused as an own-records read, as /guest status does,
      // not as a missing officer permission: members may run /moderate status.
      if (subject !== actor.userId && !can(actor, "moderation.view"))
        throw new Failure(
          "forbidden",
          "You can view only your own records. Officers can look up other members.",
          0,
          { kind: "scope", scope: "owner", permission: "moderation.view" },
        );
      return statusReply(await moderation.status(actor, subject), viewer);
    }
    const target = userId(options.getString("member", true));
    const reason = options.getString("reason", true);
    const feature = options.getString("feature", true);
    if (sub === "block") {
      const duration = options.getString("duration") ?? DEFAULT_PAUSE_DURATION;
      if (!isPauseDuration(duration))
        throw new Failure("input", "Pick a duration from the list.", 0, {
          kind: "option",
          option: "duration",
        });
      const result = await moderation.block(
        actor,
        target,
        permissionsOf(feature, ALL_MEMBER_FEATURES),
        duration,
        reason,
      );
      return blockReply({ ...result, reason }, viewer);
    }
    if (feature !== ALL) {
      const result = await moderation.lift(actor, target, permissionsOf(feature, []), reason);
      return liftReply({ ...result, reason }, viewer);
    }
    // "All" lifts whatever the person has paused that the actor may lift, so read it first. The
    // permission is checked ahead of the read: someone who may lift but not look would otherwise
    // be told they lack the permission to look.
    requirePermission(actor, actor.guildId, "moderation.block");
    const { active } = await moderation.status(actor, target);
    // A server manager's pauses stay for a server manager to lift (the service refuses the whole
    // request otherwise), and the receipt says which were left.
    const held = actor.access.manager
      ? []
      : active.filter((pause) => pause.by?.level === "manager").map((pause) => pause.permission);
    const lifting = active.map((pause) => pause.permission).filter((id) => !held.includes(id));
    // Nothing to lift is the receipt's "nothing to lift" card, not a call that would refuse an
    // empty list. A self target with something paused still reaches the service's own refusal.
    const result =
      lifting.length > 0
        ? await moderation.lift(actor, target, lifting, reason)
        : { target, lifted: [], notPaused: [] };
    return liftReply({ ...result, reason, managerSet: held }, viewer);
  },
  async autocomplete(context) {
    if (focusedOption(context) !== "member") return [];
    const { actor, interaction } = context;
    // Suggestions are a way to find people to pause, so they go only to those who may pause them.
    // `status` suggests members to officers who can see pauses, and only the person to anyone else.
    if (interaction.options.getSubcommand(true) === "status")
      return completeMember(context, !can(actor, "moderation.view"));
    return can(actor, "moderation.block") ? completeMember(context) : [];
  },
});
