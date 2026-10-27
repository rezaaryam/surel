/* surel inbox: plain JavaScript, no build step. */

const ICON = {
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z"/>',
  sent: '<path d="m4 12 16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5 20 4"/>',
  archive: '<path d="M3 5h18v4H3zM5 9v10h14V9M10 13h4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  spam: '<path d="M12 3 2 20h20zM12 10v4M12 17v.5"/>',
  starred: '<path d="m12 3 2.8 5.8 6.2.8-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.8z"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  reply: '<path d="M10 8 4 13l6 5M4 13h10a6 6 0 0 1 6 6"/>',
  forward: '<path d="m14 8 6 5-6 5M20 13H10a6 6 0 0 0-6 6"/>',
  unread: '<path d="M3 6h18v12H3z"/><path d="m3 7 9 6 9-6"/>',
  clip: '<path d="M8 12.5 14.5 6a3 3 0 0 1 4.2 4.2L10.5 18.4a5 5 0 0 1-7-7L11 4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>',
  mail: '<path d="M4 6h16v12H4z"/><path d="m4.5 6.5 7.5 6 7.5-6"/>',
};
const svg = (name, fill) => `<svg viewBox="0 0 24 24" fill="${fill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (sel, root = document) => root.querySelector(sel);

/* ---------------- API ---------------- */
class ApiError extends Error {}
const realApi = {
  async call(method, path, data) {
    const res = await fetch(path, {
      method,
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
      credentials: "same-origin",
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new ApiError(out.error || res.statusText); e.status = res.status; throw e; }
    return out;
  },
  bodyFrame: (id, images) => ({ src: `/api/messages/${encodeURIComponent(id)}/body${images ? "?images=1" : ""}` }),
  attachmentUrl: (id, idx) => `/api/messages/${encodeURIComponent(id)}/attachments/${idx}`,
};
const api = window.SUREL_API || realApi;

/* ---------------- state ---------------- */
const FOLDERS = [
  ["inbox", "Inbox"], ["starred", "Starred"], ["sent", "Sent"], ["archive", "Archive"], ["spam", "Spam"], ["trash", "Trash"],
];
const state = {
  me: null, folder: "inbox", alias: "", q: "", items: [], next: null, current: null, images: false,
  view: "mail", // mail | settings
};

const app = $("#app");
const fmtDate = (ms) => {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: "numeric", month: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
};
const fullDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const who = (a) => (a && (a.name || a.address)) || "(unknown)";
const initials = (a) => who(a).replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

function toast(text) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = text; t.setAttribute("role", "status");
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ---------------- login ---------------- */
function renderLogin(message = "") {
  app.className = "";
  app.innerHTML = `<div class="login"><form id="lf">
    <div class="brand"><i>${svg("mail")}</i>surel</div>
    <p>Sign in to your inbox.</p>
    <label class="sr" for="pw">Password</label>
    <input class="field" id="pw" type="password" autocomplete="current-password" placeholder="Password" required>
    <button class="btn primary block" type="submit">Sign in</button>
    <div class="err" role="alert">${esc(message)}</div>
  </form></div>`;
  const f = $("#lf");
  $("#pw").focus();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = f.querySelector("button");
    b.disabled = true;
    try { await api.call("POST", "/api/login", { password: $("#pw").value }); await start(); }
    catch (err) { b.disabled = false; f.querySelector(".err").textContent = err.message; }
  });
}

/* ---------------- shell ---------------- */
function renderShell() {
  app.className = "";
  app.innerHTML = `<div class="shell" id="shell">
    <aside class="side" aria-label="Folders"></aside>
    <section class="list" aria-label="Messages">
      <div class="list-head">
        <button class="icon menu-btn" id="menuBtn" aria-label="Folders">${svg("menu")}</button>
        <h2 id="folderTitle"></h2>
        <input class="search" id="search" type="search" placeholder="Search" aria-label="Search messages">
      </div>
      <div class="rows" id="rows"></div>
    </section>
    <main class="read" id="read" aria-label="Message"></main>
  </div>`;
  $("#menuBtn").onclick = () => $("#shell").classList.toggle("menu");
  let timer;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value.trim(); loadList(); }, 250);
  });
  renderSide();
  renderReader();
}

function renderSide() {
  const c = (state.me && state.me.counts) || {};
  const side = $(".side");
  side.innerHTML = `<div class="brand"><i>${svg("mail")}</i>surel</div>
    <button class="btn primary compose-btn" id="composeBtn">${svg("pen")}Compose</button>
    ${FOLDERS.map(([f, label]) => {
      const n = f === "inbox" ? (c.inbox && c.inbox.unread) || "" : f === "spam" ? (c.spam && c.spam.unread) || "" : "";
      return `<button class="nav ${state.view === "mail" && state.folder === f ? "on" : ""}" data-folder="${f}">${svg(f, f === "starred" && false)}${label}<span class="n">${n || ""}</span></button>`;
    }).join("")}
    ${state.me && state.me.aliases.length ? `<h4>Addresses</h4>
      <button class="nav alias ${state.alias === "" ? "on" : ""}" data-alias="">${svg("at")}<b>All addresses</b></button>
      ${state.me.aliases.map((a) => `<button class="nav alias ${state.alias === a.address ? "on" : ""}" data-alias="${esc(a.address)}">${svg("at")}<b>${esc(a.address)}</b></button>`).join("")}` : ""}
    <div class="foot"><button class="linkbtn" id="settingsBtn">Addresses and settings</button><button class="linkbtn" id="logoutBtn">Sign out</button></div>`;
  side.querySelectorAll("[data-folder]").forEach((b) => b.onclick = () => {
    state.view = "mail"; state.folder = b.dataset.folder; state.current = null;
    $("#shell").classList.remove("menu", "reading");
    renderSide(); loadList(); renderReader();
  });
  side.querySelectorAll("[data-alias]").forEach((b) => b.onclick = () => {
    state.alias = b.dataset.alias; $("#shell").classList.remove("menu");
    renderSide(); loadList();
  });
  $("#composeBtn").onclick = () => compose();
  $("#settingsBtn").onclick = () => { state.view = "settings"; $("#shell").classList.remove("menu"); $("#shell").classList.add("reading"); renderSide(); renderSettings(); };
  $("#logoutBtn").onclick = async () => { await api.call("POST", "/api/logout"); renderLogin(); };
}

async function refreshMe() {
  state.me = await api.call("GET", "/api/me");
  renderSide();
}

/* ---------------- list ---------------- */
async function loadList(more = false) {
  const rows = $("#rows");
  $("#folderTitle").textContent = (FOLDERS.find((f) => f[0] === state.folder) || [])[1] || "";
  const p = new URLSearchParams({ folder: state.folder });
  if (state.alias) p.set("alias", state.alias);
  if (state.q) p.set("q", state.q);
  if (more && state.next) p.set("before", state.next);
  try {
    const res = await api.call("GET", "/api/messages?" + p);
    state.items = more ? state.items.concat(res.items) : res.items;
    state.next = res.next;
  } catch (e) { if (e.status === 401) return renderLogin(); rows.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  renderRows();
}

function renderRows() {
  const rows = $("#rows");
  if (!state.items.length) {
    rows.innerHTML = `<div class="empty">${state.q ? "Nothing matches your search." : "No messages here."}</div>`;
    return;
  }
  const showTo = state.folder === "sent";
  rows.innerHTML = state.items.map((m) => `<button class="row ${m.read ? "" : "unread"} ${state.current && state.current.id === m.id ? "on" : ""}" data-id="${m.id}">
      <span class="dot"></span>
      <span class="who">${esc(showTo ? "To: " + (m.to.map(who).join(", ") || "") : who(m.from))}</span>
      <time datetime="${new Date(m.date).toISOString()}">${fmtDate(m.date)}</time>
      <span class="subj">${esc(m.subject || "(no subject)")}</span>
      <span class="snip">${esc(m.snippet)}</span>
      ${m.starred || m.attachments || state.alias === "" && state.me && state.me.aliases.length > 1 ? `<span class="meta">${m.starred ? '<span class="star">★ Starred</span>' : ""}${m.attachments ? `<span>${m.attachments} attachment${m.attachments > 1 ? "s" : ""}</span>` : ""}${state.me && state.me.aliases.length > 1 ? `<span>${esc(m.alias)}</span>` : ""}</span>` : ""}
    </button>`).join("") + (state.next ? `<button class="btn more" id="moreBtn">Load older messages</button>` : "");
  rows.querySelectorAll(".row").forEach((r) => r.onclick = () => openMessage(r.dataset.id));
  const mb = $("#moreBtn"); if (mb) mb.onclick = () => loadList(true);
}

/* ---------------- reader ---------------- */
async function openMessage(id) {
  state.view = "mail"; state.images = false;
  try { state.current = await api.call("GET", "/api/messages/" + encodeURIComponent(id)); }
  catch (e) { return toast(e.message); }
  const it = state.items.find((m) => m.id === id);
  if (it && !it.read) { it.read = true; refreshMe(); }
  $("#shell").classList.add("reading");
  renderRows(); renderReader();
}

function renderReader() {
  const read = $("#read");
  const m = state.current;
  if (state.view === "settings") return;
  if (!m) { read.innerHTML = `<div class="read-empty">Select a message to read it.</div>`; return; }
  const inTrash = m.folder === "trash";
  read.innerHTML = `<div class="read-bar">
      <button class="icon back" id="backBtn" aria-label="Back">${svg("back")}</button>
      <button class="icon" data-act="archive" aria-label="Archive" title="Archive (e)">${svg("archive")}</button>
      <button class="icon" data-act="delete" aria-label="${inTrash ? "Delete forever" : "Move to trash"}" title="Delete (#)">${svg("trash")}</button>
      <button class="icon" data-act="unread" aria-label="Mark as unread" title="Mark as unread">${svg("unread")}</button>
      <button class="icon ${m.starred ? "on" : ""}" data-act="star" aria-label="${m.starred ? "Remove star" : "Star"}" aria-pressed="${m.starred}">${svg("starred", m.starred)}</button>
      <span class="sp"></span>
      <button class="icon" data-act="reply" aria-label="Reply" title="Reply (r)">${svg("reply")}</button>
      <button class="icon" data-act="forward" aria-label="Forward">${svg("forward")}</button>
    </div>
    <article class="msg">
      <h1>${esc(m.subject || "(no subject)")}</h1>
      <div class="from"><span class="avatar">${esc(initials(m.from))}</span>
        <div style="min-width:0"><b>${esc(who(m.from))}</b><small>${esc(m.from.address)} to ${esc(m.to.map((a) => a.address).join(", ") || m.alias)}${m.cc.length ? ", cc " + esc(m.cc.map((a) => a.address).join(", ")) : ""}</small></div>
        <time>${fullDate(m.date)}</time></div>
      ${m.hasHtml ? `${state.images ? "" : `<div class="imgnote"><span>Remote images are hidden to protect your privacy.</span><button class="btn" id="imgBtn">Show images</button></div>`}
        <iframe class="body-frame" id="bodyFrame" title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>`
        : `<div class="body-text">${esc(m.text)}</div>`}
      ${m.attachmentList && m.attachmentList.length ? `<div class="atts">${m.attachmentList.map((a) => `<a class="att" href="${api.attachmentUrl(m.id, a.idx)}" download="${esc(a.filename)}">${svg("clip")}<span>${esc(a.filename)}</span><small>${fmtSize(a.size)}</small></a>`).join("")}</div>` : ""}
      <div class="reply-row"><button class="btn" data-act="reply">${svg("reply")}Reply</button><button class="btn" data-act="forward">${svg("forward")}Forward</button></div>
    </article>`;
  if (m.hasHtml) {
    const f = $("#bodyFrame");
    const src = api.bodyFrame(m.id, state.images);
    const fit = () => {
      try {
        const doc = f.contentDocument;
        f.style.height = Math.max(120, doc.documentElement.scrollHeight + 4) + "px";
        // only offer "Show images" when the message really has remote images
        const note = read.querySelector(".imgnote");
        if (note && !doc.querySelector('img[src^="http"], [style*="url(http"], [background^="http"]')) note.remove();
      } catch (e) { f.style.height = "70vh"; }
    };
    f.addEventListener("load", () => { fit(); setTimeout(fit, 400); });
    if (src.srcdoc != null) f.srcdoc = src.srcdoc; else f.src = src.src;
    const ib = $("#imgBtn"); if (ib) ib.onclick = () => { state.images = true; renderReader(); };
  }
  $("#backBtn").onclick = () => { $("#shell").classList.remove("reading"); };
  read.querySelectorAll("[data-act]").forEach((b) => b.onclick = () => act(b.dataset.act));
}

async function act(what) {
  const m = state.current;
  if (!m) return;
  try {
    if (what === "reply" || what === "forward") return compose(what, m);
    if (what === "star") { m.starred = !m.starred; await api.call("PATCH", "/api/messages/" + m.id, { starred: m.starred }); const it = state.items.find((x) => x.id === m.id); if (it) it.starred = m.starred; renderReader(); renderRows(); return; }
    if (what === "unread") { await api.call("PATCH", "/api/messages/" + m.id, { read: false }); toast("Marked as unread"); }
    if (what === "archive") { await api.call("PATCH", "/api/messages/" + m.id, { folder: m.folder === "archive" ? "inbox" : "archive" }); toast(m.folder === "archive" ? "Moved to inbox" : "Archived"); }
    if (what === "delete") { const r = await api.call("DELETE", "/api/messages/" + m.id); toast(r.deleted ? "Deleted forever" : "Moved to trash"); }
    state.current = null;
    $("#shell").classList.remove("reading");
    await Promise.all([loadList(), refreshMe()]);
    renderReader();
  } catch (e) { toast(e.message); }
}

/* ---------------- compose ---------------- */
function quote(m) {
  const head = `On ${fullDate(m.date)}, ${who(m.from)} <${m.from.address}> wrote:`;
  return `\n\n${head}\n` + String(m.text || "").split("\n").map((l) => "> " + l).join("\n");
}

function compose(mode, m) {
  const old = $(".sheet"); if (old) old.remove();
  const me = state.me || { aliases: [], defaultFrom: "" };
  const froms = me.aliases.filter((a) => a.active).map((a) => a.address);
  if (me.defaultFrom && !froms.includes(me.defaultFrom)) froms.unshift(me.defaultFrom);
  const from = m && froms.includes(m.alias) ? m.alias : state.alias && froms.includes(state.alias) ? state.alias : froms[0] || "";
  const re = (s) => (/^re:/i.test(s) ? s : "Re: " + s), fw = (s) => (/^fwd?:/i.test(s) ? s : "Fwd: " + s);
  const to = mode === "reply" ? m.from.address : "";
  const subject = mode === "reply" ? re(m.subject) : mode === "forward" ? fw(m.subject) : "";
  const body = mode === "reply" ? quote(m) : mode === "forward" ? `\n\n---------- Forwarded message ----------\nFrom: ${who(m.from)} <${m.from.address}>\nDate: ${fullDate(m.date)}\nSubject: ${m.subject}\n\n${m.text || ""}` : "";

  const s = document.createElement("form");
  s.className = "sheet"; s.setAttribute("aria-label", "New message");
  s.innerHTML = `<div class="sheet-head"><span>${mode === "reply" ? "Reply" : mode === "forward" ? "Forward" : "New message"}</span><button type="button" class="icon" id="closeC" aria-label="Close">${svg("close")}</button></div>
    <label><b>From</b>${froms.length > 1 ? `<select name="from">${froms.map((f) => `<option ${f === from ? "selected" : ""}>${esc(f)}</option>`).join("")}</select>` : `<input name="from" value="${esc(from)}" ${froms.length ? "readonly" : ""} placeholder="you@yourdomain.com">`}</label>
    <label><b>To</b><input name="to" value="${esc(to)}" placeholder="name@example.com, …" autocomplete="email" ${mode === "reply" ? "" : "autofocus"}></label>
    <label><b>Cc</b><input name="cc" placeholder="optional"></label>
    <label><b>Subject</b><input name="subject" value="${esc(subject)}"></label>
    <textarea name="text" aria-label="Message">${esc(body)}</textarea>
    <div class="sheet-foot"><span class="err" role="alert"></span><button class="btn primary" type="submit">Send</button></div>`;
  document.body.appendChild(s);
  const ta = s.querySelector("textarea");
  if (mode === "reply") { ta.focus(); ta.setSelectionRange(0, 0); } else (s.querySelector('[name="to"]')).focus();
  $("#closeC").onclick = () => s.remove();
  s.addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = s.querySelector('[type="submit"]'), err = s.querySelector(".err");
    b.disabled = true; err.textContent = "";
    const fd = Object.fromEntries(new FormData(s));
    try {
      await api.call("POST", "/api/send", { ...fd, inReplyTo: mode === "reply" ? m.messageId : "" });
      s.remove(); toast("Sent");
      if (state.folder === "sent") loadList();
      refreshMe();
    } catch (x) { b.disabled = false; err.textContent = x.message; }
  });
}

/* ---------------- settings: addresses ---------------- */
function renderSettings() {
  const read = $("#read");
  const list = (state.me && state.me.aliases) || [];
  const dom = (state.me && state.me.domain) || "yourdomain.com";
  read.innerHTML = `<div class="read-bar"><button class="icon back" id="backBtn" aria-label="Back">${svg("back")}</button><b>Addresses</b></div>
    <section class="settings">
      <h1>Your addresses</h1>
      <p>Mail to these addresses on ${esc(dom)} lands here. Turn one off to reject its mail. With no addresses, every message to the domain is accepted.</p>
      ${list.length ? list.map((a) => `<div class="al"><div><b>${esc(a.address)}</b><br><small>${esc(a.name || "No display name")}${a.forwardTo ? " · copy to " + esc(a.forwardTo) : ""}${a.active ? "" : " · off"}</small></div>
        <div><button class="btn" data-toggle="${esc(a.address)}">${a.active ? "Turn off" : "Turn on"}</button> <button class="btn" data-del="${esc(a.address)}">Remove</button></div></div>`).join("") : `<div class="empty">No addresses yet.</div>`}
      <form class="al-form" id="alForm">
        <input class="field" name="address" placeholder="hello@${esc(dom)}" required aria-label="Address">
        <input class="field" name="name" placeholder="Display name" aria-label="Display name">
        <input class="field full" name="forwardTo" placeholder="Also forward to (optional, verified in Email Routing)" aria-label="Forward to">
        <button class="btn primary" type="submit">Add address</button>
        <span class="err full" role="alert"></span>
      </form>
    </section>`;
  $("#backBtn").onclick = () => { $("#shell").classList.remove("reading"); state.view = "mail"; renderSide(); renderReader(); };
  read.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = async () => {
    const a = list.find((x) => x.address === b.dataset.toggle);
    await api.call("POST", "/api/aliases", { ...a, active: !a.active }); await refreshMe(); renderSettings();
  });
  read.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    await api.call("DELETE", "/api/aliases/" + encodeURIComponent(b.dataset.del)); await refreshMe(); renderSettings();
  });
  $("#alForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try { await api.call("POST", "/api/aliases", fd); await refreshMe(); renderSettings(); toast("Address added"); }
    catch (x) { e.target.querySelector(".err").textContent = x.message; }
  });
}

/* ---------------- keyboard ---------------- */
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey || !state.me) return;
  const i = state.items.findIndex((m) => state.current && m.id === state.current.id);
  if (e.key === "c") { e.preventDefault(); compose(); }
  else if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
  else if (e.key === "j" && state.items[i + 1]) openMessage(state.items[i + 1].id);
  else if (e.key === "k" && i > 0) openMessage(state.items[i - 1].id);
  else if (e.key === "e") act("archive");
  else if (e.key === "#") act("delete");
  else if (e.key === "r") { e.preventDefault(); act("reply"); }
  else if (e.key === "Escape") { const s = $(".sheet"); if (s) s.remove(); else $("#shell") && $("#shell").classList.remove("reading", "menu"); }
});

/* ---------------- start ---------------- */
async function start() {
  try { state.me = await api.call("GET", "/api/me"); }
  catch (e) { return renderLogin(e.status === 401 ? "" : e.message); }
  renderShell();
  await loadList();
}
start();
