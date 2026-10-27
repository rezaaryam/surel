/**
 * surel: email on your own domain, running entirely on Cloudflare.
 *
 *   email()  receives every message sent to your domain (Email Routing)
 *   fetch()  serves the inbox UI (static assets) and its JSON API
 */
import { handleEmail } from "./inbound.js";
import { handleApi } from "./api.js";

export default {
  async email(message, env, ctx) {
    await handleEmail(message, env, ctx);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    // everything else is the inbox app in public/
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "same-origin");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(res.body, { status: res.status, headers });
  },
};
