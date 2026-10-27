/**
 * Small stand-ins for the Cloudflare bindings, good enough to run the Worker in Node:
 *   DB      D1 API on top of node:sqlite (real SQL, real schema)
 *   BUCKET  R2 API on a Map
 *   EMAIL   send_email binding that records what was sent
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async all() { return { results: db.prepare(sql).all(...args), success: true }; },
    async first() { return db.prepare(sql).get(...args) || null; },
    async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    _exec() { return db.prepare(sql).run(...args); },
  });
  return {
    prepare: (sql) => stmt(sql),
    async batch(list) { db.exec("BEGIN"); try { const out = list.map((s) => s._exec()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    _db: db,
  };
}

export function fakeR2() {
  const m = new Map();
  const toBytes = async (v) => (typeof v === "string" ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v instanceof ArrayBuffer ? v : await new Response(v).arrayBuffer()));
  return {
    async put(key, value, opts = {}) { m.set(key, { bytes: await toBytes(value), meta: opts.httpMetadata || {} }); },
    async get(key) {
      const o = m.get(key);
      if (!o) return null;
      return { body: new Blob([o.bytes]).stream(), httpMetadata: o.meta, text: async () => new TextDecoder().decode(o.bytes), arrayBuffer: async () => o.bytes.buffer };
    },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
    _map: m,
  };
}

export function fakeEmail({ fail } = {}) {
  const sent = [];
  return {
    async send(msg) {
      if (fail) { const e = new Error(fail); e.code = fail; throw e; }
      sent.push(msg);
      return { messageId: `<${sent.length}@cf>` };
    },
    sent,
  };
}

export function makeEnv(extra = {}) {
  return { DB: fakeD1(), BUCKET: fakeR2(), EMAIL: fakeEmail(), SUREL_PASSWORD: "correct horse", DOMAIN: "example.dev", DEFAULT_FROM: "hello@example.dev", DEFAULT_NAME: "Reza", ...extra };
}

/** An inbound message like Email Routing passes to email(). */
export function fakeInbound(raw, { from = "sender@outside.test", to = "hello@example.dev" } = {}) {
  const bytes = new TextEncoder().encode(raw);
  const calls = { rejected: null, forwarded: [] };
  return {
    from, to, rawSize: bytes.length,
    raw: new Blob([bytes]).stream(),
    headers: new Headers(),
    setReject(reason) { calls.rejected = reason; },
    async forward(addr) { calls.forwarded.push(addr); },
    calls,
  };
}

export const SAMPLE = [
  "From: Sari Wulandari <sari@client.test>",
  "To: Reza <hello@example.dev>",
  "Subject: Website brief",
  "Date: Mon, 26 Oct 2026 09:12:00 +0700",
  "Message-ID: <brief-1@client.test>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  'Content-Type: multipart/alternative; boundary="b2"',
  "",
  "--b2",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hi Reza,",
  "",
  "Here is the brief for the new site. Can we talk on Friday?",
  "> an older quoted line",
  "",
  "--b2",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Hi Reza,</p><p>Here is the <b>brief</b> for the new site. Can we talk on Friday?</p><img src="https://tracker.test/pixel.gif"><script>alert(1)</script>',
  "--b2--",
  "",
  "--b1",
  'Content-Type: text/plain; name="brief.txt"',
  'Content-Disposition: attachment; filename="brief.txt"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("Pages: home, about, contact.").toString("base64"),
  "--b1--",
  "",
].join("\r\n");
