/**
 * One owner, one password. The password is a Worker secret (SUREL_PASSWORD);
 * a successful login gets a signed, HttpOnly session cookie.
 *
 * For extra protection, put the Worker behind Cloudflare Access as well.
 */

const COOKIE = "surel_session";
const DAY = 24 * 60 * 60;
const enc = new TextEncoder();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey(env) {
  const secret = env.SESSION_SECRET || env.SUREL_PASSWORD;
  if (!secret) throw new Error("Set the SUREL_PASSWORD secret first: npx wrangler secret put SUREL_PASSWORD");
  return crypto.subtle.importKey("raw", enc.encode("surel:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Compare two strings without leaking where they differ. */
export async function sameText(a, b) {
  const key = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [x, y] = await Promise.all([crypto.subtle.sign("HMAC", key, enc.encode(String(a))), crypto.subtle.sign("HMAC", key, enc.encode(String(b)))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

export async function makeSession(env, days = 30, now = Date.now()) {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Math.floor(now / 1000) + days * DAY })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function checkSession(env, token, now = Date.now()) {
  if (!token || token.indexOf(".") < 0) return false;
  const [payload, sig] = token.split(".");
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await hmacKey(env), fromB64url(sig), enc.encode(payload)); } catch (e) { return false; }
  if (!ok) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return exp * 1000 > now;
  } catch (e) { return false; }
}

export function readCookie(request, name = COOKIE) {
  const h = request.headers.get("Cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return "";
}

export function sessionCookie(token, maxAge = 30 * DAY) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export async function isAuthed(request, env) {
  return checkSession(env, readCookie(request));
}
