-- migrations/015_member_blocks.sql (TaruBot 2.45.0: per-person moderation; owner decisions of
-- 2026-10-12). A pause stops one person using one feature, for example someone abusing /suggest,
-- without touching their Discord roles. It is deny-only: the permission catalog (src/domain/rbac.ts)
-- says what a person holds, and an active pause here takes a held permission away from can().
--
-- member_blocks: one row per pause, written once and kept as history.
--   `permission` names a TaruBot permission by id. The set a pause may name is the application's
--   (BLOCKABLE in src/domain/rbac.ts: member and baseline features); the column only requires the
--   id's shape, so allowing staff permissions later needs no migration, and an id a later release
--   drops is ignored when read.
--   `batch_id` ties the rows one /moderate block or Moderation-page action wrote together.
--   `reason` is shown to the paused person (owner decision Q5 A) and to officers who can see
--   pauses; it never goes in the audit table. `issuer_level` is whether a server manager or an
--   officer with moderation.block set it: officers may lift or change only their own level.
--   `expires_at` is the end, compared on the database clock; NULL lasts until lifted. A pause that
--   has ended stays active in this table until the next write closes it (lift_reason 'expired',
--   no lifter), which keeps the one-open-pause-per-person-and-feature index simple.
--   `lifted_at`, `lifted_by` and `lift_reason` are filled once, by a person or by that closing.
--
-- Rows are never deleted and only the lift columns are ever written, and only once: a trigger
-- refuses everything else, whatever path tries it (a bug, an operator's SQL). The reasons are
-- private text, so they are kept like guest revocations: until a server's data is removed.
--
-- Foreign key: (guild_id, user_id) to guild_users, so a pause names someone TaruBot has seen in
-- that server (a current or former member). Nothing deletes guild_users rows.
--
-- Resulting state: one empty table and its indexes. Additive; needs no superuser. 2.44.0 refuses
-- to start on this schema head, so going back needs the pre-migration backup.

CREATE TABLE member_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  guild_id external_id NOT NULL,
  user_id external_id NOT NULL,
  permission text NOT NULL CHECK (permission ~ '^[a-z]+(\.[a-z_]+)+$' AND length(permission) <= 64),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  issuer_level text NOT NULL CHECK (issuer_level IN ('manager', 'moderator')),
  actor_id external_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  lifted_at timestamptz,
  lifted_by external_id,
  lift_reason text CHECK (lift_reason IS NULL OR char_length(lift_reason) BETWEEN 1 AND 1000),
  FOREIGN KEY (guild_id, user_id) REFERENCES guild_users (guild_id, user_id),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (lifted_at IS NOT NULL OR (lifted_by IS NULL AND lift_reason IS NULL)),
  -- Only the closing of an ended pause has no lifter. IS NOT DISTINCT FROM, because "= 'expired'"
  -- is NULL for a missing reason, and a CHECK accepts NULL.
  CHECK (lifted_at IS NULL OR lifted_by IS NOT NULL OR lift_reason IS NOT DISTINCT FROM 'expired')
);

-- At most one open pause per person and feature: a change lifts the old one in the same
-- transaction as it writes the new one. This is also the read enrichActor makes on every
-- resolution of a non-manager.
CREATE UNIQUE INDEX member_blocks_open ON member_blocks (guild_id, user_id, permission)
  WHERE lifted_at IS NULL;
-- A server's pauses, newest first (the Moderation page), and one person's history.
CREATE INDEX member_blocks_guild ON member_blocks (guild_id, created_at DESC);
CREATE INDEX member_blocks_batch ON member_blocks (batch_id);

CREATE FUNCTION member_blocks_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Pauses are kept as history and never deleted';
  END IF;
  IF OLD.lifted_at IS NOT NULL THEN
    RAISE EXCEPTION 'A pause that was lifted is fixed';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.guild_id IS DISTINCT FROM OLD.guild_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.permission IS DISTINCT FROM OLD.permission OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.issuer_level IS DISTINCT FROM OLD.issuer_level
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'Only the lift of a pause can be written';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_blocks_update BEFORE UPDATE ON member_blocks
  FOR EACH ROW EXECUTE FUNCTION member_blocks_history();
CREATE TRIGGER member_blocks_delete BEFORE DELETE ON member_blocks
  FOR EACH ROW EXECUTE FUNCTION member_blocks_history();
