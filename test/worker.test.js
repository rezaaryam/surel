import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { makeEnv, fakeInbound, fakeEmail, SAMPLE } from "../testing/fakes.js";
import { snippetOf } from "../src/store.js";
import { htmlToText, isBlocked } from "../src/inbound.js";
import { validate, textToHtml } from "../src/outbound.js";
import { makeSession, checkSession, sameText } from "../src/auth.js";
import { bodyPolicy } from "../src/api.js";

const BASE = "https://mail.example.dev";
async function login(env) {
  const res = await worker.fetch(new Request(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: env.SUREL_PASSWORD }) }), env);
  assert.equal(res.status, 200);
  return res.headers.get("Set-Cookie").split(";")[0];
}
function call(env, cookie, method, path, data) {
  return worker.fetch(new Request(BASE + path, {
    method,
    headers: { Cookie: cookie || "", ...(data ? { "Content-Type": "application/json" } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  }), env);
}
async function receive(env, raw = SAMPLE, opts) {
  const msg = fakeInbound(raw, opts);
  await worker.email(msg, env, { waitUntil: (p) => p });
  return msg;
}

/* ---------------- receiving ---------------- */

test("receive: a message is parsed and stored with its bodies and attachment", async () => {
  const env = makeEnv();
  const msg = await receive(env);
  assert.equal(msg.calls.rejected, null);
  const row = await env.DB.prepare("SELECT * FROM messages").first();
  assert.equal(row.folder, "inbox");
  assert.equal(row.alias, "hello@example.dev");
  assert.equal(row.from_addr, "sari@client.test");
  assert.equal(row.from_name, "Sari Wulandari");
  assert.equal(row.subject, "Website brief");
  assert.equal(row.attachments, 1);
  assert.equal(row.has_html, 1);
  assert.equal(row.message_id, "<brief-1@client.test>");
  assert.equal(row.date, Date.parse("2026-10-26T02:12:00Z"));
  assert.match(row.snippet, /^Hi Reza, Here is the brief/);
  assert.doesNotMatch(row.snippet, /older quoted/, "quoted lines are left out of the preview");
  const keys = [...env.BUCKET._map.keys()].sort();
  assert.deepEqual(keys, [`att/${row.id}/0`, `body/${row.id}.html`, `body/${row.id}.txt`, `raw/${row.id}.eml`]);
});

test("receive: aliases decide who gets mail; catch-all and block list", async () => {
  const env = makeEnv();
  // no aliases yet: everything is accepted
  assert.equal((await receive(env, SAMPLE, { to: "anything@example.dev" })).calls.rejected, null);

  await call(env, await login(env), "POST", "/api/aliases", { address: "hello@example.dev" });
  await call(env, await login(env), "POST", "/api/aliases", { address: "old@example.dev", active: false });
  assert.equal((await receive(env, SAMPLE, { to: "hello@example.dev" })).calls.rejected, null);
  assert.equal((await receive(env, SAMPLE, { to: "old@example.dev" })).calls.rejected, "This address is not in use.");
  assert.equal((await receive(env, SAMPLE, { to: "random@example.dev" })).calls.rejected, "Unknown address.");

  env.CATCH_ALL = "true";
  assert.equal((await receive(env, SAMPLE, { to: "random@example.dev" })).calls.rejected, null);

  env.BLOCK_SENDERS = "@spam.test, bad@x.test";
  assert.equal((await receive(env, SAMPLE, { from: "a@spam.test" })).calls.rejected, "Sender blocked.");
  assert.equal(isBlocked(env, "BAD@x.test"), true);
  assert.equal(isBlocked(env, "good@x.test"), false);
});

test("receive: forwards a copy when an address or FORWARD_TO asks for it", async () => {
  const env = makeEnv();
  const cookie = await login(env);
  await call(env, cookie, "POST", "/api/aliases", { address: "hello@example.dev", forwardTo: "me@gmail.test" });
  assert.deepEqual((await receive(env)).calls.forwarded, ["me@gmail.test"]);
  env.FORWARD_TO = "backup@gmail.test";
  await call(env, cookie, "POST", "/api/aliases", { address: "hello@example.dev" });
  assert.deepEqual((await receive(env)).calls.forwarded, ["backup@gmail.test"]);
});

test("receive: a future Date header falls back to the arrival time", async () => {
  const env = makeEnv();
  const before = Date.now();
  await receive(env, SAMPLE.replace("Mon, 26 Oct 2026 09:12:00 +0700", "Mon, 26 Oct 2099 09:12:00 +0700"));
  const row = await env.DB.prepare("SELECT date FROM messages").first();
  assert.ok(row.date >= before && row.date <= Date.now() + 5);
});

/* ---------------- auth ---------------- */

test("auth: the API needs a session; wrong passwords and forged cookies are refused", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "", "GET", "/api/me")).status, 401);
  const bad = await worker.fetch(new Request(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "nope" }) }), env);
  assert.equal(bad.status, 401);
  const cookie = await login(env);
  assert.equal((await call(env, cookie, "GET", "/api/me")).status, 200);
  const [name, value] = cookie.split("=");
  const forged = name + "=" + value.slice(0, -2) + (value.endsWith("AA") ? "BB" : "AA");
  assert.equal((await call(env, forged, "GET", "/api/me")).status, 401);
  const other = makeEnv({ SUREL_PASSWORD: "different" });
  assert.equal((await call(other, cookie, "GET", "/api/me")).status, 401, "a cookie from another install does not work");
});

test("auth: sessions expire; cookie flags are strict; mutating requests must be JSON", async () => {
  const env = makeEnv();
  const t = await makeSession(env, 1, Date.now());
  assert.equal(await checkSession(env, t), true);
  assert.equal(await checkSession(env, t, Date.now() + 2 * 86400e3), false);
  assert.equal(await sameText("abc", "abc"), true);
  assert.equal(await sameText("abc", "abd"), false);
  const res = await worker.fetch(new Request(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: env.SUREL_PASSWORD }) }), env);
  const set = res.headers.get("Set-Cookie");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(set.includes(flag), flag);
  const cookie = set.split(";")[0];
  const form = await worker.fetch(new Request(BASE + "/api/send", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: "to=a@b.test" }), env);
  assert.equal(form.status, 415, "plain form posts (cross-site) are rejected");
});

/* ---------------- reading ---------------- */

test("api: list, search, open (marks read), star, archive, trash, delete for good", async () => {
  const env = makeEnv();
  await receive(env);
  await receive(env, SAMPLE.replace("Website brief", "Invoice October").replace("sari@client.test", "billing@vendor.test"));
  const cookie = await login(env);

  let list = await (await call(env, cookie, "GET", "/api/messages?folder=inbox")).json();
  assert.equal(list.items.length, 2);
  const search = await (await call(env, cookie, "GET", "/api/messages?folder=inbox&q=invoice")).json();
  assert.deepEqual(search.items.map((m) => m.subject), ["Invoice October"]);
  const id = search.items[0].id;

  const me1 = await (await call(env, cookie, "GET", "/api/me")).json();
  assert.equal(me1.counts.inbox.unread, 2);
  const opened = await (await call(env, cookie, "GET", "/api/messages/" + id)).json();
  assert.equal(opened.read, true);
  assert.match(opened.text, /Here is the brief/);
  assert.deepEqual(opened.attachmentList.map((a) => [a.filename, a.mime, a.size]), [["brief.txt", "text/plain", 28]]);
  assert.equal((await (await call(env, cookie, "GET", "/api/me")).json()).counts.inbox.unread, 1);

  await call(env, cookie, "PATCH", "/api/messages/" + id, { starred: true });
  const starred = await (await call(env, cookie, "GET", "/api/messages?folder=starred")).json();
  assert.deepEqual(starred.items.map((m) => m.id), [id]);

  await call(env, cookie, "PATCH", "/api/messages/" + id, { folder: "archive" });
  assert.equal((await (await call(env, cookie, "GET", "/api/messages?folder=archive")).json()).items.length, 1);
  assert.equal((await call(env, cookie, "PATCH", "/api/messages/" + id, { folder: "nowhere" })).status, 400);

  const d1 = await (await call(env, cookie, "DELETE", "/api/messages/" + id)).json();
  assert.deepEqual(d1, { ok: true, deleted: false });
  const d2 = await (await call(env, cookie, "DELETE", "/api/messages/" + id)).json();
  assert.deepEqual(d2, { ok: true, deleted: true });
  assert.equal((await call(env, cookie, "GET", "/api/messages/" + id)).status, 404);
  assert.ok(![...env.BUCKET._map.keys()].some((k) => k.includes(id)), "every stored object is removed");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?").bind(id).first()).n, 0);
});

test("api: paging with a cursor", async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) await receive(env, SAMPLE.replace("09:12:00", `09:1${i}:00`).replace("Website brief", "Brief " + i));
  const cookie = await login(env);
  const p1 = await (await call(env, cookie, "GET", "/api/messages?folder=inbox&limit=2")).json();
  assert.deepEqual(p1.items.map((m) => m.subject), ["Brief 4", "Brief 3"]);
  const p2 = await (await call(env, cookie, "GET", `/api/messages?folder=inbox&limit=2&before=${p1.next}`)).json();
  assert.deepEqual(p2.items.map((m) => m.subject), ["Brief 2", "Brief 1"]);
  const p3 = await (await call(env, cookie, "GET", `/api/messages?folder=inbox&limit=2&before=${p2.next}`)).json();
  assert.deepEqual(p3.items.map((m) => m.subject), ["Brief 0"]);
  assert.equal(p3.next, null);
});

test("api: HTML bodies are served with a strict sandbox, no scripts, and images only on request", async () => {
  const env = makeEnv();
  await receive(env);
  const cookie = await login(env);
  const id = (await (await call(env, cookie, "GET", "/api/messages")).json()).items[0].id;
  const res = await call(env, cookie, "GET", `/api/messages/${id}/body`);
  const csp = res.headers.get("Content-Security-Policy");
  assert.match(csp, /^sandbox allow-same-origin allow-popups/);
  assert.doesNotMatch(csp, /allow-scripts|allow-forms/);
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /img-src data: cid:;/, "remote images blocked by default");
  assert.match(bodyPolicy(true), /img-src data: cid: https: http:/);
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(await res.text(), /<base target="_blank">/);
  const att = await call(env, cookie, "GET", `/api/messages/${id}/attachments/0`);
  assert.equal(await att.text(), "Pages: home, about, contact.");
  assert.match(att.headers.get("Content-Disposition"), /^attachment; filename="brief.txt"/);
});

/* ---------------- sending ---------------- */

test("send: goes through the EMAIL binding with name, text and HTML, and is kept in Sent", async () => {
  const env = makeEnv();
  const cookie = await login(env);
  await call(env, cookie, "POST", "/api/aliases", { address: "reza@example.dev", name: "Reza Arya" });
  const res = await call(env, cookie, "POST", "/api/send", { from: "reza@example.dev", to: "sari@client.test, dimas@client.test", cc: "pm@client.test", subject: "Re: Website brief", text: "Friday works.\n\nSee you <then>." });
  assert.equal(res.status, 201);
  assert.equal(env.EMAIL.sent.length, 1);
  const s = env.EMAIL.sent[0];
  assert.deepEqual(s.from, { email: "reza@example.dev", name: "Reza Arya" });
  assert.deepEqual(s.to, ["sari@client.test", "dimas@client.test"]);
  assert.deepEqual(s.cc, ["pm@client.test"]);
  assert.equal(s.text, "Friday works.\n\nSee you <then>.");
  assert.match(s.html, /See you &lt;then&gt;\./);
  const sent = await (await call(env, cookie, "GET", "/api/messages?folder=sent")).json();
  assert.equal(sent.items[0].subject, "Re: Website brief");
  assert.equal(sent.items[0].read, true);
});

test("send: refuses foreign senders, bad addresses, too many recipients, and reports binding errors", async () => {
  const env = makeEnv();
  const cookie = await login(env);
  const err = async (data) => (await (await call(env, cookie, "POST", "/api/send", data)).json()).error;
  assert.match(await err({ from: "me@gmail.test", to: "a@b.test", text: "x" }), /only send from @example\.dev/);
  assert.match(await err({ to: "not-an-address", text: "x" }), /is not an email address/);
  assert.match(await err({ to: "", text: "x" }), /at least one recipient/);
  assert.match(await err({ to: Array.from({ length: 51 }, (_, i) => `u${i}@b.test`), text: "x" }), /Up to 50/);
  await call(env, cookie, "POST", "/api/aliases", { address: "off@example.dev", active: false });
  assert.match(await err({ from: "off@example.dev", to: "a@b.test", text: "x" }), /turned off/);
  env.EMAIL = fakeEmail({ fail: "E_SENDER_NOT_VERIFIED" });
  const r = await call(env, cookie, "POST", "/api/send", { to: "a@b.test", text: "x" });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /not ready for sending/);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE folder = 'sent'").first()).n, 0, "nothing is stored when sending fails");
});

test("aliases: only on your domain; update in place; remove", async () => {
  const env = makeEnv();
  const cookie = await login(env);
  assert.equal((await call(env, cookie, "POST", "/api/aliases", { address: "x@other.test" })).status, 400);
  await call(env, cookie, "POST", "/api/aliases", { address: "Hello@Example.dev", name: "A" });
  await call(env, cookie, "POST", "/api/aliases", { address: "hello@example.dev", name: "B" });
  let list = await (await call(env, cookie, "GET", "/api/aliases")).json();
  assert.deepEqual(list, [{ address: "hello@example.dev", name: "B", active: true, forwardTo: "" }]);
  await call(env, cookie, "DELETE", "/api/aliases/" + encodeURIComponent("hello@example.dev"));
  list = await (await call(env, cookie, "GET", "/api/aliases")).json();
  assert.deepEqual(list, []);
});

/* ---------------- helpers ---------------- */

test("helpers: snippets, html to text, address validation, text to html", () => {
  assert.equal(snippetOf("Hello\n> quoted\n\nworld   again"), "Hello world again");
  assert.equal(snippetOf("x".repeat(300)).length, 160);
  assert.equal(htmlToText("<style>p{}</style><p>One&nbsp;&amp; two</p><p>three<br>four</p>"), "One & two\nthree\nfour");
  const v = validate({ to: "a@b.test; c@d.test\ne@f.test", text: "x" }, { DOMAIN: "example.dev", DEFAULT_FROM: "hi@example.dev" });
  assert.deepEqual(v.to, ["a@b.test", "c@d.test", "e@f.test"]);
  assert.deepEqual(v.errors, []);
  assert.equal(textToHtml("a\nb\n\nc").includes("<p style=\"margin:0 0 14px\">a<br>b</p>"), true);
});
