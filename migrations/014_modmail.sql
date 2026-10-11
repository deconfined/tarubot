-- migrations/014_modmail.sql (TaruBot 2.43.0: mod mail, issue #60; owner decisions of 2026-10-11).
-- Members and guests open a private case with /modmail; the conversation with the server's
-- officers then happens on TaruBot's dashboard. Discord only carries the opening form and pings
-- or DMs with a case number and a link, never the text.
--
-- modmail_settings: one row per server that ever turned mod mail on (no row: off, revision 1).
--   `enabled` is the officers' switch, `revision` its optimistic lock, `last_number` the server's
--   case counter: opening a case increments it with one UPDATE ... WHERE enabled, so the row lock
--   serializes concurrent opens in one server (and the switch), and a number is never reused, not
--   even after retention deletes its case. Turning mod mail off only stops new cases.
--
-- modmail_cases: one row per case. The topic is AES-256-GCM ciphertext (nonce, ciphertext, tag)
--   under MODMAIL_KEY, which lives in host settings, never here; topic_key_id names that key (the
--   first 16 hex characters of an HMAC of it), so a later release can keep previous keys for
--   reading. Plaintext is padded first (0x80 then zeros): every topic to 512 bytes, so every topic
--   column is 540 bytes, and a body to a multiple of 256 bytes. The AAD binds a topic to its server,
--   case and opener, and a body to those plus its message ID, author, side, signing and kind, so a
--   row moved to another case or server, or re-inserted under another opener or author, fails to
--   decrypt. `state` is officers (waiting on officers), member (waiting on
--   the member) or closed; `revision` is the close/reopen lock, bumped by every change;
--   `state_since` is when the current state began (how long a case has waited). Closing sets
--   delete_after to closed_at plus 90 days; reopening clears both.
--
-- modmail_messages: the thread, append-only. kind 'message' carries a body (ciphertext and key ID);
--   'closed' and 'reopened' are the state history, shown as system lines. `side` is who acted (the
--   member who opened the case, or an officer), and an officer's `signed_as` records how the member
--   sees them: by their server name, or as "The officers". `seq` orders a case's rows, since a
--   reopen line and its reply share one transaction's now().
--
-- modmail_reads: the read log. Every view of a case page is recorded with the reader, their side
--   and the time (kind 'case'; views by the same reader within a minute are one row), and so is
--   every list that showed a case's decrypted topic (kind 'list': the inbox, or the member's own
--   list; one row per reader per case per hour). Append-only too.
--
-- Mod mail events never go in the long-lived audit table (only the officers' switch does): the
-- audit would otherwise say who opened cases long after retention deleted them. The jobs that ping
-- officers and DM members carry the case ID only: no member, no text.
--
-- Retention: the bot deletes cases past delete_after under the writer lease; the cascades remove
-- their messages, reads and history. A restored backup can bring back cases that had since expired,
-- or that were reopened or closed later; pruning deletes the expired ones again on its next pass.
--
-- Resulting state: four empty tables and one jobs index. Additive; needs no superuser. 2.42.0
-- refuses to start on this schema head, so going back needs the pre-migration backup.

CREATE TABLE modmail_settings (
  guild_id external_id PRIMARY KEY REFERENCES guilds(id),
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_by external_id,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A topic's ciphertext is the 12-byte nonce, its 512 padded bytes and the 16-byte tag.
CREATE TABLE modmail_cases (
  id uuid PRIMARY KEY,
  guild_id external_id NOT NULL REFERENCES guilds(id),
  number bigint NOT NULL CHECK (number > 0),
  opener_id external_id NOT NULL,
  state text NOT NULL CHECK (state IN ('officers', 'member', 'closed')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  state_since timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  delete_after timestamptz,
  topic bytea NOT NULL CHECK (octet_length(topic) = 540),
  topic_key_id text NOT NULL CHECK (topic_key_id ~ '^[0-9a-f]{16}$'),
  UNIQUE (guild_id, number),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((closed_at IS NULL) = (delete_after IS NULL))
);
-- A member's cases (their list, and the open and 24-hour limits); the inbox by state, oldest
-- waiting first; the retention pass.
CREATE INDEX modmail_cases_opener ON modmail_cases (guild_id, opener_id, opened_at);
CREATE INDEX modmail_cases_inbox ON modmail_cases (guild_id, state, state_since);
CREATE INDEX modmail_cases_expiry ON modmail_cases (delete_after) WHERE delete_after IS NOT NULL;

CREATE TABLE modmail_messages (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES modmail_cases(id) ON DELETE CASCADE,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  kind text NOT NULL CHECK (kind IN ('message', 'closed', 'reopened')),
  author_id external_id NOT NULL,
  side text NOT NULL CHECK (side IN ('member', 'officer')),
  signed_as text CHECK (signed_as IN ('name', 'officers')),
  -- The nonce and tag around at least one 256-byte block of padded text.
  body bytea CHECK (octet_length(body) >= 284 AND (octet_length(body) - 28) % 256 = 0),
  key_id text CHECK (key_id ~ '^[0-9a-f]{16}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((side = 'officer') = (signed_as IS NOT NULL)),
  CHECK ((kind = 'message') = (body IS NOT NULL)),
  CHECK ((body IS NULL) = (key_id IS NULL))
);
CREATE INDEX modmail_messages_case ON modmail_messages (case_id, seq);

CREATE TABLE modmail_reads (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES modmail_cases(id) ON DELETE CASCADE,
  reader_id external_id NOT NULL,
  side text NOT NULL CHECK (side IN ('member', 'officer')),
  kind text NOT NULL DEFAULT 'case' CHECK (kind IN ('case', 'list')),
  read_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX modmail_reads_case ON modmail_reads (case_id, reader_id, kind, read_at DESC);

-- Messages and reads are written once and never changed: no UPDATE, whatever path tries it (a bug,
-- an operator's SQL). DELETE stays allowed, so retention's cascade works.
CREATE FUNCTION modmail_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Mod mail % rows are append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER modmail_messages_append_only BEFORE UPDATE ON modmail_messages
  FOR EACH ROW EXECUTE FUNCTION modmail_append_only();
CREATE TRIGGER modmail_reads_append_only BEFORE UPDATE ON modmail_reads
  FOR EACH ROW EXECUTE FUNCTION modmail_append_only();

-- A case's identity and its encrypted topic never change; its state, revision and times do.
CREATE FUNCTION modmail_case_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.guild_id IS DISTINCT FROM OLD.guild_id
     OR NEW.number IS DISTINCT FROM OLD.number OR NEW.opener_id IS DISTINCT FROM OLD.opener_id
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.topic IS DISTINCT FROM OLD.topic
     OR NEW.topic_key_id IS DISTINCT FROM OLD.topic_key_id THEN
    RAISE EXCEPTION 'A mod mail case''s identity and topic are fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER modmail_case_fixed BEFORE UPDATE ON modmail_cases
  FOR EACH ROW EXECUTE FUNCTION modmail_case_fixed();

-- The notification jobs' coalescing reads a case's last ping or DM (src/application/modmail.ts).
CREATE INDEX modmail_jobs ON jobs (dedupe_key, completed_at DESC)
  WHERE kind IN ('modmail.ping', 'modmail.dm');
