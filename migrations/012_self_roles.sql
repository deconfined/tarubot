-- migrations/012_self_roles.sql (TaruBot 2.39.0: self-service roles, the first v4 use case; owner
-- request and decisions of 2026-10-09). Officers list existing Discord roles that members and
-- guests may give themselves on the web, replacing Dyno's reaction roles.
--
-- self_role_menus: one row per server holding the whole menu as one versioned JSON document
--   ({"v":1,"categories":[…]}), validated by src/domain/self-roles.ts on every read and write. A
--   document this build can't read (a newer release wrote it before a rollback, say) is never
--   overwritten by an edit: only an audited reset replaces it. `revision` is the officers'
--   optimistic lock and has nothing to do with guilds.revision, the reconciliation fence, which
--   menu edits never bump. A member's picks are NOT stored here or anywhere: Discord holds them.
--
-- The trigger: a role choice can reveal gender identity or pronouns. While a member's change waits,
--   its roles.self job holds the role IDs involved; whatever ends that job (completion, failure,
--   supersede, closeUnstarted, the 7-day expiry, the restore step, an operator's SQL), the
--   database itself clears the payload. 2.39.0 queues no roles.self job; its dispatcher completes
--   one left by 2.40.0 after a rollback as skipped, and this trigger clears it.
--
-- The indexes: My roles reads a member's newest roles.self row and the 30-day retention delete
--   scans these rows (self_role_jobs); the expiry pass touches only waiting rows, never the history
--   (self_role_waiting). Both stay unused until 2.40.0.
--
-- Resulting state: an empty table, and no existing job changes (no roles.self job exists before
-- 2.40.0). Additive; needs no superuser. 2.38.1 refuses to start on this schema head, so going back
-- needs the pre-migration backup.

-- The CHECK is a backstop for the shape the application validates; coalesce makes a document
-- without "categories" fail it rather than pass as NULL.
CREATE TABLE self_role_menus (
  guild_id external_id PRIMARY KEY REFERENCES guilds(id),
  menu jsonb NOT NULL DEFAULT '{"v":1,"categories":[]}'::jsonb
    CHECK (jsonb_typeof(menu) = 'object'
      AND coalesce(jsonb_typeof(menu->'categories') = 'array', false)),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION forget_self_role_choice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.payload := '{}'::jsonb; RETURN NEW; END $$;
CREATE TRIGGER self_role_choice_forgotten BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW
  WHEN (NEW.kind = 'roles.self' AND NEW.status IN ('succeeded', 'failed'))
  EXECUTE FUNCTION forget_self_role_choice();

CREATE INDEX self_role_jobs ON jobs (dedupe_key, created_at DESC) WHERE kind = 'roles.self';
CREATE INDEX self_role_waiting ON jobs (created_at)
  WHERE kind = 'roles.self' AND status IN ('queued', 'running', 'blocked', 'disabled');
