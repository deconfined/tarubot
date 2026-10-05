-- migrations/011_web_sessions.sql (web pages foundation; owner decisions W1 and W2 of 2026-10-04,
-- issue #43). Browser sessions for the web pages: a signed-in browser holds an opaque random token
-- in a cookie, and this table is the server side of it. The web runs inside the bot process and stays
-- dormant until WEB_PUBLIC_ORIGIN is set, so nothing writes here before then.
--
-- A row holds only the SHA-256 of the cookie token (never the token itself), the Discord user ID and
-- timestamps: no IP address, user agent, Discord token or name. Sessions are created only for users
-- some page admits, and sign-in replaces the session the browser presented, so a row is one browser.
--
-- token_hash:       SHA-256 of the cookie token, as 64 lowercase hex characters.
-- user_id:          the signed-in Discord user. No foreign key: a session is not member state, and
--                   "sign out everywhere" deletes by this column (the user_id index).
-- created_at:       when the row was written (database clock).
-- authenticated_at: when the user last proved who they are with Discord; equal to created_at today,
--                   so a later release can require a recent sign-in for sensitive writes.
-- last_seen_at:     the last request, written at most every ten minutes. The idle expiry (seven
--                   days) counts from it.
-- expires_at:       the absolute expiry, thirty days after sign-in however active the session is.
--
-- Every expiry decision uses the database clock (now()), and the web's hourly sweep deletes idle-
-- and absolutely-expired rows. The sweep scans the table, which stays small because only admitted
-- users get sessions. After any restore, delete every row (DELETE FROM web_sessions): a restored
-- backup would otherwise revive sessions signed out since it was taken. That signs everyone out,
-- which is always safe. Resulting state: an empty table. Additive; needs no superuser.

CREATE TABLE web_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id external_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- "Sign out everywhere" deletes one user's rows.
CREATE INDEX web_sessions_user ON web_sessions (user_id);
