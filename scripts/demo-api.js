/*
 * A stand-in for the Worker API, so the inbox can run on GitHub Pages as a demo.
 * Everything stays in this browser tab; nothing is sent anywhere.
 */
(function () {
  const now = Date.now(), H = 3600e3, D = 24 * H;
  const page = (title, body) => `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d1f24">${body}</div>`;
  let seq = 0;
  const mk = (o) => Object.assign({ id: "m" + ++seq, folder: "inbox", alias: "hello@studio.dev", to: [{ address: o.alias || "hello@studio.dev", name: "" }], cc: [], read: false, starred: false, size: 4200, hasHtml: !!o.html, attachments: (o.attachmentList || []).length, attachmentList: [], messageId: "", inReplyTo: "" }, o);
  const snip = (t) => t.replace(/\s+/g, " ").slice(0, 150);
  const msgs = [
    mk({ from: { address: "sari@kliniksehat.test", name: "Sari Wulandari" }, subject: "Brief for the clinic website", date: now - 2 * H,
      text: "Hi,\n\nThanks for the call yesterday. I've attached the page list and a few reference sites we like.\n\nCould you send a first estimate by Friday?\n\nSari",
      html: page("", "<p>Hi,</p><p>Thanks for the call yesterday. I've attached the <b>page list</b> and a few reference sites we like.</p><p>Could you send a first estimate by <b>Friday</b>?</p><p>Sari</p>"),
      attachmentList: [{ idx: 0, filename: "page-list.pdf", mime: "application/pdf", size: 182000 }, { idx: 1, filename: "references.txt", mime: "text/plain", size: 900 }] }),
    mk({ from: { address: "noreply@github.test", name: "GitHub" }, subject: "[rezaaryam/gerak] New star from @motionlab", date: now - 5 * H, read: true,
      text: "motionlab starred rezaaryam/gerak.\n\nYou now have 128 stars.", html: page("", "<p><b>motionlab</b> starred <b>rezaaryam/gerak</b>.</p><p>You now have 128 stars.</p>") }),
    mk({ from: { address: "dimas@tokokopi.test", name: "Dimas" }, subject: "Re: Cashier app, phase two", date: now - 1 * D, starred: true, alias: "reza@studio.dev",
      text: "Sounds good. Let's add QRIS payments first, then the table reservations.\n\n> Phase two could cover payments and reservations." }),
    mk({ from: { address: "billing@cloud.test", name: "Cloud Billing" }, subject: "Your invoice for October", date: now - 2 * D, read: true,
      text: "Your invoice for October is ready. Total: $5.00 (Workers Paid).", html: page("", "<p>Your invoice for October is ready.</p><p style='font-size:22px'><b>$5.00</b></p><p>Workers Paid plan</p>") }),
    mk({ from: { address: "hr@company.test", name: "Talent Team" }, subject: "Interview invitation: Full-stack Developer", date: now - 3 * D, alias: "reza@studio.dev", read: true,
      text: "Hello Reza,\n\nWe'd like to invite you to an interview next Tuesday at 10:00. Please reply with a time that works for you.\n\nBest regards" }),
    mk({ folder: "sent", from: { address: "hello@studio.dev", name: "Studio" }, to: [{ address: "sari@kliniksehat.test", name: "" }], subject: "Re: Brief for the clinic website", date: now - 30 * 60e3, read: true,
      text: "Hi Sari,\n\nThank you! I'll send the estimate on Thursday.\n\nReza" }),
  ].map((m) => Object.assign(m, { snippet: snip(m.text) }));
  const aliases = [
    { address: "hello@studio.dev", name: "Studio", active: true, forwardTo: "" },
    { address: "reza@studio.dev", name: "Reza", active: true, forwardTo: "" },
  ];
  const counts = () => {
    const out = {};
    for (const f of ["inbox", "sent", "archive", "trash", "spam"]) out[f] = { total: 0, unread: 0 };
    for (const m of msgs) { out[m.folder].total++; if (!m.read) out[m.folder].unread++; }
    return out;
  };
  const err = (status, message) => { const e = new Error(message); e.status = status; throw e; };
  const strip = ({ text, html, attachmentList, ...m }) => m;
  let authed = sessionStorage.getItem("surel-demo") === "1";

  window.SUREL_API = {
    async call(method, path, data) {
      await new Promise((r) => setTimeout(r, 120));
      const url = new URL(path, location.href);
      const p = url.pathname.replace(/^.*\/api\//, "/api/");
      if (p === "/api/login") { if (!data.password) err(401, "Type any password: this is a demo."); authed = true; try { sessionStorage.setItem("surel-demo", "1"); } catch (e) {} return { ok: true }; }
      if (p === "/api/logout") { authed = false; try { sessionStorage.removeItem("surel-demo"); } catch (e) {} return { ok: true }; }
      if (!authed) err(401, "Sign in first.");
      if (p === "/api/me") return { domain: "studio.dev", defaultFrom: "hello@studio.dev", aliases, counts: counts() };
      if (p === "/api/messages") {
        const f = url.searchParams.get("folder"), a = url.searchParams.get("alias"), q = (url.searchParams.get("q") || "").toLowerCase();
        const items = msgs.filter((m) => (f === "starred" ? m.starred && m.folder !== "trash" : m.folder === f) && (!a || m.alias === a) &&
          (!q || (m.subject + m.from.address + m.from.name + m.snippet).toLowerCase().includes(q))).sort((x, y) => y.date - x.date);
        return { items: items.map(strip), next: null };
      }
      let m;
      if ((m = p.match(/^\/api\/messages\/(\w+)$/))) {
        const msg = msgs.find((x) => x.id === m[1]) || err(404, "Not found.");
        if (method === "GET") { msg.read = true; return { ...msg }; }
        if (method === "PATCH") { Object.assign(msg, data); return { ok: true }; }
        if (method === "DELETE") { if (msg.folder === "trash") { msgs.splice(msgs.indexOf(msg), 1); return { ok: true, deleted: true }; } msg.folder = "trash"; return { ok: true, deleted: false }; }
      }
      if (p === "/api/send") {
        if (!String(data.to || "").includes("@")) err(400, "Add at least one recipient.");
        const sent = mk({ folder: "sent", read: true, from: { address: data.from, name: "" }, to: String(data.to).split(",").map((s) => ({ address: s.trim(), name: "" })), subject: data.subject, date: Date.now(), text: data.text, alias: data.from });
        sent.snippet = snip(sent.text);
        msgs.push(sent);
        return { id: sent.id, note: "Demo: nothing was actually sent." };
      }
      if (p === "/api/aliases" && method === "POST") {
        if (!/@studio\.dev$/.test(data.address)) err(400, "Addresses must end with @studio.dev.");
        const i = aliases.findIndex((x) => x.address === data.address);
        const a = { address: data.address, name: data.name || "", active: data.active !== false, forwardTo: data.forwardTo || "" };
        if (i >= 0) aliases[i] = a; else aliases.push(a);
        return { ok: true };
      }
      if ((m = p.match(/^\/api\/aliases\/(.+)$/))) { const i = aliases.findIndex((x) => x.address === decodeURIComponent(m[1])); if (i >= 0) aliases.splice(i, 1); return { ok: true }; }
      err(404, "Unknown endpoint.");
    },
    bodyFrame(id) { const msg = msgs.find((x) => x.id === id); return { srcdoc: `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:16px}</style>${msg.html}` }; },
    attachmentUrl(id, idx) { return "data:text/plain;charset=utf-8," + encodeURIComponent("Demo attachment. In surel this downloads the real file from R2."); },
  };
})();
