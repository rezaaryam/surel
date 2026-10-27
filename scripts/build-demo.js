/*
 * Copy the inbox app into docs/app and plug in the demo API, for GitHub Pages.
 *   npm run demo
 */
import { cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const root = new URL("..", import.meta.url);
const out = new URL("docs/app/", root);
mkdirSync(out, { recursive: true });
for (const f of ["app.js", "app.css"]) cpSync(new URL("public/" + f, root), new URL(f, out));
cpSync(new URL("scripts/demo-api.js", root), new URL("demo-api.js", out));
const html = readFileSync(new URL("public/index.html", root), "utf8")
  .replace('<script src="app.js" type="module"></script>', '<script src="demo-api.js"></script>\n<script src="app.js" type="module"></script>')
  .replace("<title>surel</title>", "<title>surel demo</title>");
writeFileSync(new URL("index.html", out), html);
console.log("docs/app is up to date.");
