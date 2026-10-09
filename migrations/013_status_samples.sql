-- migrations/013_status_samples.sql (TaruBot 2.41.0: the public status page's 90-day history; owner
-- decisions of 2026-10-09). Anyone may open /status, which shows TaruBot's live status and one
-- uptime bar per UTC day for the last 90 days.
--
-- status_samples: one row per five-minute bucket while a TaruBot process holds the writer lease,
--   written by src/application/public-status.ts with one idempotent statement (the bucket's start
--   as the key, ON CONFLICT DO NOTHING), so a restart or a second tick inside a bucket adds
--   nothing. A bucket without a row counts as down: TaruBot wasn't running, or had no database.
--   Rows are deleted 90 days after their bucket by the same timer, all but the earliest, which
--   marks where the history starts.
--
-- A row holds only the bucket, process-wide booleans, two small state words and the version that
-- wrote it: no server, member, channel, role or address, and nothing a visitor sent. The CHECK on
-- sampled_at keeps every key on a five-minute boundary with no fractional seconds.
--
-- Resulting state: an empty table. Additive; needs no superuser. 2.40.0 refuses to start on this
-- schema head, so going back needs the pre-migration backup. A restore loses the samples written
-- since the backup, and the page then shows those buckets as down; nothing else depends on them.

CREATE TABLE status_samples (
  sampled_at timestamptz PRIMARY KEY CHECK (extract(epoch FROM sampled_at) % 300 = 0),
  ready boolean NOT NULL,
  discord boolean NOT NULL,
  database boolean NOT NULL,
  lodestone text NOT NULL CHECK (lodestone IN ('available', 'cooling_down', 'unreachable')),
  changes text NOT NULL CHECK (changes IN ('live', 'paused')),
  version text NOT NULL CHECK (version ~ '^[0-9A-Za-z.+-]{1,128}$')
);
