/**
 * Storage for surel: message rows in D1, bodies and attachments in R2.
 *
 * R2 keys:
 *   raw/<id>.eml          the original message as received (inbound only)
 *   body/<id>.html        HTML body, when there is one
 *   body/<id>.txt         plain text body
 *   att/<id>/<index>      attachment content
 */

export const FOLDERS = ["inbox", "sent", "archive", "trash", "spam"];

const LIST_COLUMNS =
  "id, folder, alias, from_addr, from_name, to_json, cc_json, subject, snippet, date, read, starred, size, has_html, attachments";

export function rowToMessage(r) {
  if (!r) return null;
  return {
    id: r.id,
    folder: r.folder,
    alias: r.alias,
    from: { address: r.from_addr, name: r.from_name },
    to: JSON.parse(r.to_json || "[]"),
    cc: JSON.parse(r.cc_json || "[]"),
    subject: r.subject,
    snippet: r.snippet,
    date: r.date,
    read: !!r.read,
    starred: !!r.starred,
    size: r.size,
    hasHtml: !!r.has_html,
    attachments: r.attachments,
    messageId: r.message_id,
    inReplyTo: r.in_reply_to,
  };
}

/** A short preview from the text body: no quoted replies, collapsed whitespace. */
export function snippetOf(text, max = 160) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l));
  const s = lines.join(" ").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

export async function saveMessage(env, m, parts = {}) {
  await env.DB.prepare(
    `INSERT INTO messages (id, folder, alias, from_addr, from_name, to_json, cc_json, subject, snippet, date, read, starred, size, has_html, attachments, message_id, in_reply_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      m.id, m.folder, m.alias, m.from.address, m.from.name || "",
      JSON.stringify(m.to || []), JSON.stringify(m.cc || []),
      m.subject || "", snippetOf(parts.text), m.date, m.read ? 1 : 0, 0,
      m.size || 0, parts.html ? 1 : 0, (parts.attachments || []).length,
      m.messageId || "", m.inReplyTo || ""
    )
    .run();

  const puts = [];
  if (parts.raw) puts.push(env.BUCKET.put(`raw/${m.id}.eml`, parts.raw));
  if (parts.text != null) puts.push(env.BUCKET.put(`body/${m.id}.txt`, parts.text));
  if (parts.html) puts.push(env.BUCKET.put(`body/${m.id}.html`, parts.html));
  (parts.attachments || []).forEach((a, i) => {
    puts.push(env.BUCKET.put(`att/${m.id}/${i}`, a.content, { httpMetadata: { contentType: a.mime } }));
  });
  await Promise.all(puts);

  if ((parts.attachments || []).length) {
    await env.DB.batch(
      parts.attachments.map((a, i) =>
        env.DB.prepare("INSERT INTO attachments (message_id, idx, filename, mime, size) VALUES (?, ?, ?, ?, ?)")
          .bind(m.id, i, a.filename || `attachment-${i + 1}`, a.mime || "application/octet-stream", a.size || 0)
      )
    );
  }
}

/**
 * List messages, newest first. `before` is a cursor: the date of the last
 * message on the previous page.
 */
export async function listMessages(env, { folder = "inbox", alias = "", q = "", starred = false, before = 0, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (starred) where.push("starred = 1 AND folder != 'trash'");
  else { where.push("folder = ?"); args.push(folder); }
  if (alias) { where.push("alias = ?"); args.push(alias); }
  if (q) {
    where.push("(subject LIKE ? OR from_addr LIKE ? OR from_name LIKE ? OR snippet LIKE ?)");
    const like = `%${q.replace(/[%_]/g, (c) => "\\" + c)}%`;
    args.push(like, like, like, like);
  }
  if (before) { where.push("date < ?"); args.push(before); }
  const sql = `SELECT ${LIST_COLUMNS} FROM messages WHERE ${where.join(" AND ")} ORDER BY date DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, Math.min(limit, 100) + 1).all();
  const items = results.slice(0, limit).map(rowToMessage);
  return { items, next: results.length > limit ? items[items.length - 1].date : null };
}

export async function getMessage(env, id) {
  const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
  if (!row) return null;
  const msg = rowToMessage(row);
  const [txt, atts] = await Promise.all([
    env.BUCKET.get(`body/${id}.txt`),
    env.DB.prepare("SELECT idx, filename, mime, size FROM attachments WHERE message_id = ? ORDER BY idx").bind(id).all(),
  ]);
  msg.text = txt ? await txt.text() : "";
  msg.attachmentList = atts.results;
  return msg;
}

export async function getHtml(env, id) {
  const obj = await env.BUCKET.get(`body/${id}.html`);
  return obj ? obj.text() : null;
}

export async function updateMessage(env, id, patch) {
  const sets = [];
  const args = [];
  if ("read" in patch) { sets.push("read = ?"); args.push(patch.read ? 1 : 0); }
  if ("starred" in patch) { sets.push("starred = ?"); args.push(patch.starred ? 1 : 0); }
  if ("folder" in patch) {
    if (!FOLDERS.includes(patch.folder)) { const e = new Error("Unknown folder: " + patch.folder); e.status = 400; throw e; }
    sets.push("folder = ?"); args.push(patch.folder);
  }
  if (!sets.length) return false;
  const r = await env.DB.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
  return r.meta.changes > 0;
}

/** Delete for good: the row, its attachments, and every R2 object. */
export async function deleteMessage(env, id) {
  const atts = await env.DB.prepare("SELECT idx FROM attachments WHERE message_id = ?").bind(id).all();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(id),
    env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id),
  ]);
  await env.BUCKET.delete([`raw/${id}.eml`, `body/${id}.txt`, `body/${id}.html`, ...atts.results.map((a) => `att/${id}/${a.idx}`)]);
}

export async function counts(env) {
  const { results } = await env.DB.prepare(
    "SELECT folder, COUNT(*) AS total, SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread FROM messages GROUP BY folder"
  ).all();
  const out = Object.fromEntries(FOLDERS.map((f) => [f, { total: 0, unread: 0 }]));
  for (const r of results) out[r.folder] = { total: r.total, unread: r.unread || 0 };
  return out;
}

export async function listAliases(env) {
  const { results } = await env.DB.prepare("SELECT address, name, active, forward_to FROM aliases ORDER BY address").all();
  return results.map((a) => ({ address: a.address, name: a.name, active: !!a.active, forwardTo: a.forward_to }));
}

export async function getAlias(env, address) {
  const a = await env.DB.prepare("SELECT address, name, active, forward_to FROM aliases WHERE address = ?").bind(address.toLowerCase()).first();
  return a ? { address: a.address, name: a.name, active: !!a.active, forwardTo: a.forward_to } : null;
}

export async function upsertAlias(env, { address, name = "", active = true, forwardTo = "" }) {
  await env.DB.prepare(
    `INSERT INTO aliases (address, name, active, forward_to) VALUES (?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET name = excluded.name, active = excluded.active, forward_to = excluded.forward_to`
  ).bind(address.toLowerCase(), name, active ? 1 : 0, forwardTo).run();
}

export async function deleteAlias(env, address) {
  await env.DB.prepare("DELETE FROM aliases WHERE address = ?").bind(address.toLowerCase()).run();
}
