-- surel: messages, attachments, and addresses on your domain
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  folder      TEXT NOT NULL DEFAULT 'inbox',   -- inbox | sent | archive | trash | spam
  alias       TEXT NOT NULL,                   -- your address this message belongs to
  from_addr   TEXT NOT NULL,
  from_name   TEXT NOT NULL DEFAULT '',
  to_json     TEXT NOT NULL DEFAULT '[]',
  cc_json     TEXT NOT NULL DEFAULT '[]',
  subject     TEXT NOT NULL DEFAULT '',
  snippet     TEXT NOT NULL DEFAULT '',
  date        INTEGER NOT NULL,                -- milliseconds since 1970
  read        INTEGER NOT NULL DEFAULT 0,
  starred     INTEGER NOT NULL DEFAULT 0,
  size        INTEGER NOT NULL DEFAULT 0,
  has_html    INTEGER NOT NULL DEFAULT 0,
  attachments INTEGER NOT NULL DEFAULT 0,
  message_id  TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS messages_folder_date ON messages (folder, date DESC);
CREATE INDEX IF NOT EXISTS messages_alias ON messages (alias, folder, date DESC);

CREATE TABLE IF NOT EXISTS attachments (
  message_id TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  PRIMARY KEY (message_id, idx)
);

CREATE TABLE IF NOT EXISTS aliases (
  address    TEXT PRIMARY KEY,                 -- e.g. hello@yourdomain.com
  name       TEXT NOT NULL DEFAULT '',         -- display name when sending
  active     INTEGER NOT NULL DEFAULT 1,
  forward_to TEXT NOT NULL DEFAULT ''          -- optional copy to another inbox
);
