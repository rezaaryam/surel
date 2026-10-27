/**
 * Sending, through the Cloudflare Email Service binding (send_email, named EMAIL).
 * The sender must be one of your addresses; the sent copy is stored in "sent".
 */
import { saveMessage, getAlias } from "./store.js";
import { htmlToText } from "./inbound.js";

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export function parseAddressList(v) {
  const list = Array.isArray(v) ? v : String(v || "").split(/[,;\n]/);
  return list.map((s) => String(s).trim()).filter(Boolean);
}

export function validate(input, env) {
  const errors = [];
  const to = parseAddressList(input.to);
  const cc = parseAddressList(input.cc);
  const bcc = parseAddressList(input.bcc);
  if (!to.length) errors.push("Add at least one recipient.");
  for (const a of [...to, ...cc, ...bcc]) if (!EMAIL_RE.test(a)) errors.push(`"${a}" is not an email address.`);
  if (to.length + cc.length + bcc.length > 50) errors.push("Up to 50 recipients per message.");
  const from = String(input.from || env.DEFAULT_FROM || "").trim().toLowerCase();
  if (!EMAIL_RE.test(from)) errors.push("Choose one of your addresses to send from.");
  else if (env.DOMAIN && !from.endsWith("@" + String(env.DOMAIN).toLowerCase())) errors.push(`You can only send from @${env.DOMAIN}.`);
  if (!String(input.subject || "").trim() && !String(input.text || "").trim()) errors.push("Write a subject or a message.");
  return { errors, to, cc, bcc, from };
}

/** Escape text and keep line breaks, for the HTML version of a plain message. */
export function textToHtml(text) {
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#1d1f24">${esc
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("")}</div>`;
}

export async function sendMessage(env, input) {
  const v = validate(input, env);
  if (v.errors.length) { const e = new Error(v.errors.join(" ")); e.status = 400; throw e; }
  const alias = await getAlias(env, v.from);
  if (alias && !alias.active) { const e = new Error("That address is turned off."); e.status = 400; throw e; }
  const name = (alias && alias.name) || env.DEFAULT_NAME || "";

  const text = String(input.text || "");
  const html = input.html ? String(input.html) : textToHtml(text);
  const subject = String(input.subject || "").trim();
  const payload = {
    from: name ? { email: v.from, name } : v.from,
    to: v.to.length === 1 ? v.to[0] : v.to,
    subject,
    text: text || htmlToText(html),
    html,
  };
  if (v.cc.length) payload.cc = v.cc;
  if (v.bcc.length) payload.bcc = v.bcc;

  let result;
  try { result = await env.EMAIL.send(payload); }
  catch (err) {
    const e = new Error(
      err && err.code === "E_SENDER_NOT_VERIFIED" ? "Your domain is not ready for sending yet. Onboard it under Email Service > Email Sending."
      : err && err.code === "E_RATE_LIMIT_EXCEEDED" ? "Sending limit reached. Try again later."
      : "Sending failed: " + ((err && err.message) || err)
    );
    e.status = 502;
    throw e;
  }

  const id = crypto.randomUUID();
  await saveMessage(env, {
    id, folder: "sent", alias: v.from,
    from: { address: v.from, name },
    to: v.to.map((address) => ({ address, name: "" })),
    cc: v.cc.map((address) => ({ address, name: "" })),
    subject, date: Date.now(), read: true,
    size: text.length + html.length,
    messageId: (result && result.messageId) || "",
    inReplyTo: input.inReplyTo || "",
  }, { text: payload.text, html });
  return { id, messageId: (result && result.messageId) || "" };
}
