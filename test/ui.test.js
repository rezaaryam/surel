/* The inbox app in a real browser, running against the demo API (docs/app). */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = fileURLToPath(new URL("../docs/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
let server, base, browser;

before(async () => {
  server = http.createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    try { res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream" }); res.end(await readFile(join(ROOT, p))); }
    catch (e) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/app/`;
  browser = await chromium.launch();
});
after(async () => { await browser.close(); server.close(); });

async function signedIn(viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(base);
  await page.fill("#pw", "demo");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".row");
  return page;
}

test("ui: sign in, read a message with attachments, star it, see it under Starred", async () => {
  const p = await signedIn();
  assert.equal(await p.locator(".row").count(), 5);
  await p.locator(".row", { hasText: "Brief for the clinic website" }).click();
  await p.waitForSelector(".msg h1");
  assert.equal(await p.textContent(".msg h1"), "Brief for the clinic website");
  assert.equal(await p.locator(".att").count(), 2);
  assert.equal(await p.locator(".imgnote").count(), 0, "no remote images, so no image notice");
  assert.equal(await p.locator(".row.unread", { hasText: "Brief for the clinic" }).count(), 0, "opening marks it read");
  await p.click('[data-act="star"]');
  await p.click('[data-folder="starred"]');
  await p.waitForFunction(() => document.querySelectorAll(".row").length === 2);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test("ui: reply opens with the quote and the right sender, sending lands in Sent", async () => {
  const p = await signedIn();
  await p.locator(".row", { hasText: "Cashier app" }).click();
  await p.waitForSelector(".msg h1");
  await p.keyboard.press("r");
  await p.waitForSelector(".sheet");
  assert.equal(await p.inputValue('[name="to"]'), "dimas@tokokopi.test");
  assert.equal(await p.inputValue('[name="subject"]'), "Re: Cashier app, phase two");
  assert.equal(await p.inputValue('[name="from"]'), "reza@studio.dev", "replies come from the address the mail was sent to");
  assert.match(await p.inputValue("textarea"), /wrote:\n> Sounds good/);
  await p.click('.sheet [type="submit"]');
  await p.waitForSelector(".toast");
  await p.click('[data-folder="sent"]');
  await p.waitForFunction(() => [...document.querySelectorAll(".row .subj")].some((s) => s.textContent === "Re: Cashier app, phase two"));
  await p.close();
});

test("ui: search, filter by address, archive with the keyboard", async () => {
  const p = await signedIn();
  await p.fill("#search", "invoice");
  await p.waitForFunction(() => document.querySelectorAll(".row").length === 1);
  await p.fill("#search", "");
  await p.waitForFunction(() => document.querySelectorAll(".row").length === 5);
  await p.click('[data-alias="reza@studio.dev"]');
  await p.waitForFunction(() => document.querySelectorAll(".row").length === 2);
  await p.locator(".row").first().click();
  await p.waitForSelector(".msg h1");
  await p.keyboard.press("e");
  await p.waitForFunction(() => document.querySelectorAll(".row").length === 1);
  await p.close();
});

test("ui: phone layout shows one pane at a time and never scrolls sideways", async () => {
  const p = await signedIn({ width: 390, height: 844 });
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth), 390);
  await p.locator(".row").first().click();
  await p.waitForFunction(() => document.querySelector(".shell").classList.contains("reading"));
  await p.click("#backBtn");
  await p.waitForFunction(() => !document.querySelector(".shell").classList.contains("reading"));
  await p.click("#menuBtn");
  await p.waitForFunction(() => document.querySelector(".shell").classList.contains("menu"));
  await p.close();
});
