/** The JSON API used by the web inbox. Everything except login needs a session. */
import { isAuthed, makeSession, sessionCookie, clearCookie, sameText } from "./auth.js";
import * as store from "./store.js";
import { sendMessage } from "./outbound.js";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const fail = (status, error) => json({ error }, status);

async function body(request) {
  if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
    const e = new Error("Send JSON."); e.status = 415; throw e;
  }
  try { return await request.json(); } catch (e) { const x = new Error("Invalid JSON."); x.status = 400; throw x; }
}

/** CSP for message bodies: no scripts, no forms, remote images only when asked. */
export function bodyPolicy(allowImages) {
  return [
    // same origin (so the inbox can size the frame) but no scripts, forms, or plugins
    "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    "script-src 'none'",
    "default-src 'none'",
    `img-src data: cid:${allowImages ? " https: http:" : ""}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
  ].join("; ");
}

export async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  try {
    if (path === "/api/login" && method === "POST") {
      const { password } = await body(request);
      if (!env.SUREL_PASSWORD) return fail(500, "The SUREL_PASSWORD secret is not set.");
      if (!(await sameText(password || "", env.SUREL_PASSWORD))) {
        await new Promise((r) => setTimeout(r, 400));
        return fail(401, "Wrong password.");
      }
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(await makeSession(env)) });
    }
    if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });

    if (!(await isAuthed(request, env))) return fail(401, "Sign in first.");

    if (path === "/api/me" && method === "GET") {
      return json({ domain: env.DOMAIN || "", defaultFrom: env.DEFAULT_FROM || "", aliases: await store.listAliases(env), counts: await store.counts(env) });
    }

    if (path === "/api/messages" && method === "GET") {
      const p = url.searchParams;
      const folder = p.get("folder") || "inbox";
      if (folder !== "starred" && !store.FOLDERS.includes(folder)) return fail(400, "Unknown folder.");
      return json(await store.listMessages(env, {
        folder, starred: folder === "starred", alias: p.get("alias") || "", q: (p.get("q") || "").slice(0, 200),
        before: Number(p.get("before")) || 0, limit: Math.min(Number(p.get("limit")) || 50, 100),
      }));
    }

    let m;
    if ((m = path.match(/^\/api\/messages\/([\w-]+)$/))) {
      const id = m[1];
      if (method === "GET") {
        const msg = await store.getMessage(env, id);
        if (!msg) return fail(404, "Not found.");
        if (!msg.read) { await store.updateMessage(env, id, { read: true }); msg.read = true; }
        return json(msg);
      }
      if (method === "PATCH") {
        const patch = await body(request);
        const ok = await store.updateMessage(env, id, patch);
        return ok ? json({ ok: true }) : fail(404, "Not found.");
      }
      if (method === "DELETE") {
        // first delete moves to trash; deleting from trash removes it for good
        const msg = await store.getMessage(env, id);
        if (!msg) return fail(404, "Not found.");
        if (msg.folder === "trash") { await store.deleteMessage(env, id); return json({ ok: true, deleted: true }); }
        await store.updateMessage(env, id, { folder: "trash" });
        return json({ ok: true, deleted: false });
      }
    }

    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/body$/)) && method === "GET") {
      const html = await store.getHtml(env, m[1]);
      if (html == null) return fail(404, "No HTML body.");
      const page = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:16px;font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d1f24;word-wrap:break-word}img{max-width:100%;height:auto}</style>${html}`;
      return new Response(page, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": bodyPolicy(url.searchParams.get("images") === "1"),
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "private, max-age=300",
        },
      });
    }

    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/attachments\/(\d+)$/)) && method === "GET") {
      const row = await env.DB.prepare("SELECT filename, mime FROM attachments WHERE message_id = ? AND idx = ?").bind(m[1], Number(m[2])).first();
      const obj = row && (await env.BUCKET.get(`att/${m[1]}/${m[2]}`));
      if (!obj) return fail(404, "Not found.");
      const safeName = row.filename.replace(/["\\\r\n]/g, "_");
      return new Response(obj.body, {
        headers: {
          "Content-Type": row.mime,
          "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
        },
      });
    }

    if (path === "/api/send" && method === "POST") {
      return json(await sendMessage(env, await body(request)), 201);
    }

    if (path === "/api/aliases" && method === "GET") return json(await store.listAliases(env));
    if (path === "/api/aliases" && method === "POST") {
      const a = await body(request);
      const address = String(a.address || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return fail(400, "That is not an email address.");
      if (env.DOMAIN && !address.endsWith("@" + String(env.DOMAIN).toLowerCase())) return fail(400, `Addresses must end with @${env.DOMAIN}.`);
      await store.upsertAlias(env, { address, name: String(a.name || ""), active: a.active !== false, forwardTo: String(a.forwardTo || "") });
      return json({ ok: true }, 201);
    }
    if ((m = path.match(/^\/api\/aliases\/(.+)$/)) && method === "DELETE") {
      await store.deleteAlias(env, decodeURIComponent(m[1]));
      return json({ ok: true });
    }

    return fail(404, "Unknown endpoint.");
  } catch (e) {
    if (e.status) return fail(e.status, e.message);
    console.error(e);
    return fail(500, "Something went wrong on the server.");
  }
}
