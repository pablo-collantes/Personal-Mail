// Mailbox schema, applied in order. Append new migrations; never edit old ones.
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE aliases (
      address TEXT PRIMARY KEY,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
      created_at INTEGER NOT NULL,
      first_seen_at INTEGER,
      last_seen_at INTEGER
    )`,
    `CREATE TABLE vip_rules (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
      value TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (kind, value)
    )`,
    // seq is the rowid shared with messages_fts. created/updated_modseq feed
    // JMAP-style change tracking.
    `CREATE TABLE messages (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      received_at INTEGER NOT NULL,
      envelope_from TEXT NOT NULL,
      alias TEXT NOT NULL,
      folder TEXT NOT NULL CHECK (folder IN ('inbox', 'pile', 'archive', 'trash')),
      seen INTEGER NOT NULL DEFAULT 0,
      flagged INTEGER NOT NULL DEFAULT 0,
      vip_rule_id INTEGER,
      auth TEXT NOT NULL CHECK (auth IN ('pass', 'fail', 'none')),
      message_id TEXT,
      in_reply_to TEXT,
      refs TEXT,
      subject TEXT NOT NULL DEFAULT '',
      from_name TEXT,
      from_address TEXT,
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      reply_to_json TEXT NOT NULL DEFAULT '[]',
      sent_at INTEGER,
      preview TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL,
      has_html INTEGER NOT NULL DEFAULT 0,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      blobs_expired INTEGER NOT NULL DEFAULT 0,
      auth_results TEXT,
      list_id TEXT,
      list_unsubscribe TEXT,
      parse_error TEXT,
      created_modseq INTEGER NOT NULL,
      updated_modseq INTEGER NOT NULL
    )`,
    `CREATE INDEX messages_folder ON messages (folder, seq)`,
    `CREATE INDEX messages_alias ON messages (alias, seq)`,
    `CREATE INDEX messages_received ON messages (received_at)`,
    `CREATE INDEX messages_updated ON messages (updated_modseq)`,
    `CREATE TABLE attachments (
      message_seq INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      filename TEXT,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      disposition TEXT,
      content_id TEXT,
      PRIMARY KEY (message_seq, idx)
    )`,
    `CREATE VIRTUAL TABLE messages_fts USING fts5(
      subject, sender, recipients, body, attachments,
      tokenize = 'unicode61 remove_diacritics 2'
    )`,
    // Deleted message ids: stops reconcile/ingest from resurrecting them, and
    // tracks R2 blobs still to be removed. Holds no message content.
    `CREATE TABLE deleted (
      id TEXT PRIMARY KEY,
      deleted_at INTEGER NOT NULL,
      modseq INTEGER NOT NULL,
      blob_keys TEXT NOT NULL,
      blobs_cleared INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX deleted_pending ON deleted (blobs_cleared)`,
  ],
  // List by receive time rather than insertion order: IMAP backfill inserts
  // old mail after new mail. (seq, the rowid, is implicitly in every index.)
  [
    `DROP INDEX messages_folder`,
    `DROP INDEX messages_alias`,
    `CREATE INDEX messages_folder ON messages (folder, received_at)`,
    `CREATE INDEX messages_alias ON messages (alias, received_at)`,
  ],
  // JMAP Email/changes reads deletions by modseq.
  [`CREATE INDEX deleted_modseq ON deleted (modseq)`],
  // The Pile goes. Mail is sorted into VIP, Inbox, Spam and the user's own
  // folders (with sorting rules), so mailboxes become rows. SQLite can't drop
  // the old folder CHECK, so the messages table is rebuilt; seq is kept, so
  // the search index (rowid = seq) still lines up. Mail already in the Pile
  // moves to the Inbox, and the VIP mail in the old Inbox to VIP.
  [
    // The modseq this change happens at ("M" below, read back from meta).
    `INSERT INTO meta (key, value) VALUES ('modseq', '1')
     ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
    `CREATE TABLE mailboxes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      sort_order INTEGER NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_modseq INTEGER NOT NULL,
      updated_modseq INTEGER NOT NULL,
      destroyed_modseq INTEGER
    )`,
    `CREATE UNIQUE INDEX mailboxes_name ON mailboxes (lower(name)) WHERE destroyed_modseq IS NULL`,
    // id, name, role, sort_order, created; the Pile is kept as destroyed so JMAP clients hear it went.
    `INSERT INTO mailboxes (id, name, role, sort_order, builtin, created_modseq, updated_modseq, destroyed_modseq)
     SELECT b.column1, b.column2, b.column3, b.column4, 1, CASE WHEN b.column5 THEN m.v ELSE 0 END, m.v,
            CASE WHEN b.column1 = 'pile' THEN m.v END
     FROM (VALUES ('vip', 'VIP', 'important', 1, 1), ('inbox', 'Inbox', 'inbox', 2, 0),
                  ('archive', 'Archive', 'archive', 3, 0), ('junk', 'Spam', 'junk', 4, 1),
                  ('trash', 'Trash', 'trash', 5, 0), ('pile', 'Pile', NULL, 6, 0)) b,
          (SELECT CAST(value AS INTEGER) AS v FROM meta WHERE key = 'modseq') m`,
    `CREATE TABLE sort_rules (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('address', 'domain', 'alias')),
      value TEXT NOT NULL,
      folder TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (kind, value)
    )`,
    // auto_filed: placed by classify (rules may re-sort it), as opposed to moved by the user.
    `CREATE TABLE messages_v4 (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      received_at INTEGER NOT NULL,
      envelope_from TEXT NOT NULL,
      alias TEXT NOT NULL,
      folder TEXT NOT NULL,
      auto_filed INTEGER NOT NULL DEFAULT 1,
      seen INTEGER NOT NULL DEFAULT 0,
      flagged INTEGER NOT NULL DEFAULT 0,
      vip_rule_id INTEGER,
      sort_rule_id INTEGER,
      auth TEXT NOT NULL CHECK (auth IN ('pass', 'fail', 'none')),
      spam_flag INTEGER,
      spam_score REAL,
      message_id TEXT,
      in_reply_to TEXT,
      refs TEXT,
      subject TEXT NOT NULL DEFAULT '',
      from_name TEXT,
      from_address TEXT,
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      reply_to_json TEXT NOT NULL DEFAULT '[]',
      sent_at INTEGER,
      preview TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL,
      has_html INTEGER NOT NULL DEFAULT 0,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      blobs_expired INTEGER NOT NULL DEFAULT 0,
      auth_results TEXT,
      list_id TEXT,
      list_unsubscribe TEXT,
      parse_error TEXT,
      created_modseq INTEGER NOT NULL,
      updated_modseq INTEGER NOT NULL
    )`,
    `INSERT INTO messages_v4 (
       seq, id, received_at, envelope_from, alias, folder, auto_filed, seen, flagged, vip_rule_id, auth,
       message_id, in_reply_to, refs, subject, from_name, from_address, to_json, cc_json, reply_to_json,
       sent_at, preview, size, has_html, attachment_count, blobs_expired, auth_results, list_id,
       list_unsubscribe, parse_error, created_modseq, updated_modseq
     )
     SELECT
       seq, id, received_at, envelope_from, alias, folder, folder IN ('inbox', 'pile'), seen, flagged, vip_rule_id, auth,
       message_id, in_reply_to, refs, subject, from_name, from_address, to_json, cc_json, reply_to_json,
       sent_at, preview, size, has_html, attachment_count, blobs_expired, auth_results, list_id,
       list_unsubscribe, parse_error, created_modseq, updated_modseq
     FROM messages`,
    `DROP TABLE messages`,
    `ALTER TABLE messages_v4 RENAME TO messages`,
    `CREATE INDEX messages_folder ON messages (folder, received_at)`,
    `CREATE INDEX messages_alias ON messages (alias, received_at)`,
    `CREATE INDEX messages_received ON messages (received_at)`,
    `CREATE INDEX messages_updated ON messages (updated_modseq)`,
    `CREATE INDEX messages_from ON messages (from_address)`,
    // The moves get modseqs M+1, M+2, ... in runs of 500 messages, so a JMAP
    // client can page through them with Email/changes instead of resyncing.
    `UPDATE messages SET folder = 'vip',
       updated_modseq = (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'modseq') + 1 + seq / 500
     WHERE folder = 'inbox' AND vip_rule_id IS NOT NULL`,
    `UPDATE messages SET folder = 'inbox',
       updated_modseq = (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'modseq') + 1 + seq / 500
     WHERE folder = 'pile'`,
    `UPDATE meta SET value = CAST(max(CAST(value AS INTEGER), coalesce((SELECT max(updated_modseq) FROM messages), 0)) AS TEXT)
     WHERE key = 'modseq'`,
  ],
  // Rules can match who mail was sent to: a +tag, or any address at a domain
  // (the "alias" kind now also matches To and Cc). SQLite can't widen a CHECK,
  // so sort_rules is rebuilt, ids kept (messages.sort_rule_id points at them).
  // And a folder can show its mail in the clients' Inbox view; VIP starts so.
  [
    `CREATE TABLE sort_rules_v5 (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('address', 'domain', 'alias', 'tag', 'to_domain')),
      value TEXT NOT NULL,
      folder TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (kind, value)
    )`,
    `INSERT INTO sort_rules_v5 (id, kind, value, folder, created_at) SELECT id, kind, value, folder, created_at FROM sort_rules`,
    `DROP TABLE sort_rules`,
    `ALTER TABLE sort_rules_v5 RENAME TO sort_rules`,
    `ALTER TABLE mailboxes ADD COLUMN show_in_inbox INTEGER NOT NULL DEFAULT 0`,
    `UPDATE mailboxes SET show_in_inbox = 1 WHERE id = 'vip'`,
  ],
  // Sent: the mail the user sent from their own accounts, read from each
  // IMAP account's Sent folder. It starts next to the Inbox (same sortOrder,
  // and "Inbox" sorts first by name). If the user already has a folder with
  // that name, the first free one of "Sent mail" and "Sent (imported)".
  [
    `INSERT INTO meta (key, value) VALUES ('modseq', '1')
     ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
    `INSERT INTO mailboxes (id, name, role, sort_order, builtin, created_modseq, updated_modseq)
     SELECT 'sent',
            (SELECT n.column1 FROM (VALUES ('Sent', 1), ('Sent mail', 2), ('Sent (imported)', 3)) n
             WHERE NOT EXISTS (SELECT 1 FROM mailboxes WHERE lower(name) = lower(n.column1) AND destroyed_modseq IS NULL)
             ORDER BY n.column2 LIMIT 1),
            'sent', coalesce((SELECT sort_order FROM mailboxes WHERE id = 'inbox'), 2), 1, m.v, m.v
     FROM (SELECT CAST(value AS INTEGER) AS v FROM meta WHERE key = 'modseq') m`,
  ],
  // Inbox categories (categories.ts). The four built-in ones live in code; this table holds the
  // user's own. category_by says who chose a message's category: 'guess' (the quick guess,
  // waiting for the classifier), 'model' (the classifier), 'sender' (the user's "categorize
  // sender", category_senders) or 'none' (Sent mail, which has none). NULL is mail from before
  // this: the Mailbox guesses it in batches (CategoryStore.fillGuesses).
  [
    `CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      color TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX categories_name ON categories (lower(name))`,
    `CREATE TABLE category_senders (
      address TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `ALTER TABLE messages ADD COLUMN category TEXT`,
    `ALTER TABLE messages ADD COLUMN category_by TEXT`,
    `ALTER TABLE messages ADD COLUMN category_confidence REAL`,
    `UPDATE messages SET category_by = 'none' WHERE folder = 'sent'`,
    `CREATE INDEX messages_category ON messages (category, received_at)`,
    `CREATE INDEX messages_category_by ON messages (category_by, received_at)`,
  ],
];

/** Applies the migrations not yet applied, up to `target` (all of them by default; tests stop early). */
export function migrate(sql: SqlStorage, target = MIGRATIONS.length): void {
  sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0];
  for (let version = row ? Number(row.value) : 0; version < target; version++) {
    for (const statement of MIGRATIONS[version]!) sql.exec(statement);
    sql.exec(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      String(version + 1),
    );
  }
}
