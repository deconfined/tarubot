/**
 * The column values every application-created `guilds` row starts with
 * (CFG-07, as changed in 2.35.0). The first `/config` save and
 * `/setup onboarding confirm:true` spread this into their
 * `.insert(t.guilds).values({ id, ...NEW_GUILD_ROW })`, so a server TaruBot
 * first meets through either starts with effects on and the role layout off:
 * TaruBot never reorders or hoists a new server's roles unless an officer asks
 * with `/config role_layout enabled:true`.
 *
 * Only the application's inserts change. The column default for
 * `role_layout_enabled` stays `true` in schema 010 (2.35.0 has no migration),
 * the legacy importer keeps writing `role_layout_enabled: false` explicitly,
 * and existing rows keep whatever they saved; an insert that finds the row
 * already there changes nothing (`onConflictDoNothing`).
 */
export const NEW_GUILD_ROW = { effects_enabled: true, role_layout_enabled: false } as const;
