/**
 * Receiving: Cloudflare Email Routing hands every message for your domain to
 * the Worker's `email()` handler. surel parses it, decides whether to accept
 * it, and stores it.
 */
import PostalMime from "postal-mime";
import { saveMessage, getAlias, listAliases } from "./store.js";

const MAX_SIZE = 25 * 1024 * 1024;

/** Read a ReadableStream (message.raw) into one Uint8Array. */
export async function readAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Should this recipient be accepted?
 * - an address listed as an alias: accepted when active
 * - any other address on the domain: accepted only if CATCH_ALL is "true",
 *   or when no aliases are set up yet (so a fresh install receives everything)
 */
export async function decide(env, recipient) {
  const alias = await getAlias(env, recipient);
  if (alias) return alias.active ? { accept: true, alias } : { accept: false, reason: "This address is not in use." };
  if (String(env.CATCH_ALL) === "true") return { accept: true, alias: null };
  const all = await listAliases(env);
  if (!all.length) return { accept: true, alias: null };
  return { accept: false, reason: "Unknown address." };
}

/** Is the sender on the block list (BLOCK_SENDERS: comma separated addresses or @domains)? */
export function isBlocked(env, from) {
  const list = String(env.BLOCK_SENDERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const f = String(from || "").toLowerCase();
  return list.some((b) => (b.startsWith("@") ? f.endsWith(b) : f === b));
}

/** Turn parsed postal-mime output into what surel stores. */
export function toStored(parsed, { id, recipient, rawSize, now = Date.now() }) {
  const addr = (a) => ({ address: (a && a.address) || "", name: (a && a.name) || "" });
  const date = parsed.date ? Date.parse(parsed.date) : NaN;
  return {
    message: {
      id,
      folder: "inbox",
      alias: recipient.toLowerCase(),
      from: addr(parsed.from),
      to: (parsed.to || []).map(addr),
      cc: (parsed.cc || []).map(addr),
      subject: parsed.subject || "",
      // trust the sender's clock unless it is missing or far in the future
      date: Number.isFinite(date) && date < now + 60 * 60 * 1000 ? date : now,
      read: false,
      size: rawSize,
      messageId: parsed.messageId || "",
      inReplyTo: parsed.inReplyTo || "",
    },
    parts: {
      text: parsed.text || (parsed.html ? htmlToText(parsed.html) : ""),
      html: parsed.html || "",
      attachments: (parsed.attachments || [])
        .filter((a) => a.disposition !== "inline" || !a.contentId)
        .map((a) => ({
          filename: a.filename || "",
          mime: a.mimeType || "application/octet-stream",
          content: a.content,
          size: a.content ? a.content.byteLength : 0,
        })),
    },
  };
}

/** A rough plain-text version of an HTML body, for previews and search. */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The Worker's email() handler. */
export async function handleEmail(message, env, ctx) {
  if (message.rawSize > MAX_SIZE) return message.setReject("Message too large.");
  if (isBlocked(env, message.from)) return message.setReject("Sender blocked.");

  const verdict = await decide(env, message.to);
  if (!verdict.accept) return message.setReject(verdict.reason);

  const raw = await readAll(message.raw);
  const parsed = await PostalMime.parse(raw);
  const id = crypto.randomUUID();
  const { message: m, parts } = toStored(parsed, { id, recipient: message.to, rawSize: message.rawSize || raw.length });
  await saveMessage(env, m, { ...parts, raw });

  // optional copy to another inbox, per address or for everything
  const forwardTo = (verdict.alias && verdict.alias.forwardTo) || env.FORWARD_TO;
  if (forwardTo) {
    const p = message.forward(forwardTo).catch((e) => console.error("forward failed", e));
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
  }
  return id;
}
