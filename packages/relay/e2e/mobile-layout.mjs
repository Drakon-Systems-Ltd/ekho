// Mobile layout regression: no horizontal overflow, no iOS-autozoom inputs, and every
// essential control rendered, visible and fully inside the viewport.
// Usage: npm run test:mobile [-- screenshotDir]   (builds ui-dist first)
// Needs Playwright + Chromium (not a repo dependency): `npm i -D playwright` or set
// PLAYWRIGHT_MODULE to its path. Exits non-zero on any violation.
import { createRequire } from "node:module";
import fs from "node:fs";
import { startMock } from "./mock-console.mjs";

const require = createRequire(import.meta.url);
let pw;
try { pw = require(process.env.PLAYWRIGHT_MODULE || "playwright"); }
catch { console.error("playwright not found: npm i -D playwright, or set PLAYWRIGHT_MODULE"); process.exit(2); }
const { chromium, devices } = pw;
const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });

// Phones, a coarse-pointer tablet (input rule must apply, layout must not pan) and a
// fine-pointer desktop (input rule must NOT apply: desktop typography unchanged).
const PROFILES = [
  ["360", { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } }, "phone"],
  ["390", { ...devices["iPhone 14"], viewport: { width: 390, height: 780 } }, "phone"],
  ["414", { ...devices["iPhone 11 Pro Max"], viewport: { width: 414, height: 780 } }, "phone"],
  ["ipad-1024", devices["iPad Mini landscape"], "tablet"],
  ["ipad-768", devices["iPad Mini"], "tablet"],
  ["desktop-780", { viewport: { width: 780, height: 800 } }, "desktop"],
  ["desktop-861", { viewport: { width: 861, height: 800 } }, "desktop"],
  ["desktop-1280", { viewport: { width: 1280, height: 800 } }, "desktop"],
];
const ROUTES = [["wire", ""], ["classic", "#classic"], ["deck", "#deck"]];
// Controls that must exist, be visible and sit wholly inside the viewport. A route that
// renders an empty shell or an error page fails here instead of passing vacuously.
const ESSENTIAL = {
  "wire/list": [[".topbar .brand", 1], [".topbar .tbbtn", 7], [".tbbtn.tb-deck", 1]],
  "wire/chat": [[".topbar .tbbtn", 7], ["textarea", 1]],
  "classic/list": [["header.appbar", 1]],
  "deck/list": [[".cmd-deck .modes .mode", 3], [".cmd-deck .pill--alerts", 1], [".cmd-deck .exit", 1]],
};

function measure(essential) {
  const vw = window.innerWidth;
  const visible = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  // Content may be clipped only inside a usable horizontal scroller that itself fits the
  // viewport, an ellipsis box, or the decorative deck ticker. A layout shell clipping it
  // (.app{overflow:hidden}) is the bug itself, so it does not count.
  const contained = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); const r = p.getBoundingClientRect(); if (r.left < -1 || r.right > vw + 1) continue; if (cs.overflowX === "auto" || cs.overflowX === "scroll" || (cs.overflowX === "hidden" && cs.textOverflow === "ellipsis") || p.matches(".cmd-deck .tick")) return true; } return false; };
  const label = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : ""}`;
  const clipped = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
    if (!visible(el)) continue; // fixed-position elements included
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if ((r.right > vw + 1 && r.left < vw - 1) || (r.left < -1 && r.right > 1)) { if (!contained(el)) clipped.push(`${label(el)}[${Math.round(r.left)}..${Math.round(r.right)}]`); }
  }
  const fields = [...document.querySelectorAll("input,textarea,select")].filter((e) => visible(e) && !/^(checkbox|radio|range|hidden|file)$/.test(e.type));
  const small = fields.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => `${label(e)}:${getComputedStyle(e).fontSize}`);
  const missing = [];
  for (const [sel, n] of essential) {
    const ok = [...document.querySelectorAll(sel)].filter((e) => { if (!visible(e)) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1; });
    if (ok.length < n) missing.push(`${sel}:${ok.length}/${n}`);
  }
  const de = document.documentElement;
  return { vw, scrollW: Math.max(de.scrollWidth, document.body.scrollWidth), clipped: clipped.slice(0, 8), small, fields: fields.length, missing };
}

const { srv, port } = await startMock();
const browser = await chromium.launch();
let failures = 0;
const report = [];
for (const [w, prof, kind] of PROFILES) {
  for (const [name, hash] of ROUTES) {
    const ctx = await browser.newContext(prof);
    await ctx.addInitScript(() => { localStorage.setItem("ekho.operator.token", "t"); localStorage.setItem("ekho.operator.fleetId", "f1"); localStorage.setItem("ekho.operator.email", "m@example.com"); });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/ui/${hash}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const views = [["list", null]];
    if (name === "wire") views.push(["chat", async () => { await page.locator(".sidebar button, .sidebar [role=button]").filter({ hasText: /Jarvis|hash/ }).first().click(); await page.waitForTimeout(500); }]);
    for (const [view, enter] of views) {
      if (enter) await enter();
      const m = await page.evaluate(measure, ESSENTIAL[`${name}/${view}`] || []);
      const problems = [];
      if (m.scrollW > m.vw) problems.push("pans");
      if (m.clipped.length) problems.push("clipped");
      if (m.missing.length) problems.push("missing");
      if (kind === "desktop") { if (m.fields && !m.small.length && name === "wire") problems.push("16px rule leaked to desktop"); }
      else if (m.small.length) problems.push("small inputs");
      report.push({ w, name, view, ...m, ok: !problems.length });
      if (problems.length) failures++;
      console.log(`${problems.length ? "FAIL" : "ok  "} ${w} ${name}/${view}: ${problems.join(",") || "-"} scrollW=${m.scrollW} clipped=${JSON.stringify(m.clipped)} small=${JSON.stringify(m.small)} missing=${JSON.stringify(m.missing)}`);
      if (shots && (w === "390" || kind !== "phone")) await page.screenshot({ path: `${shots}/${w}-${name}-${view}.png` });
    }
    await ctx.close();
  }
}
await browser.close(); srv.close();
if (shots) fs.writeFileSync(`${shots}/results.json`, JSON.stringify(report, null, 1));
if (failures) { console.error(`${failures} view(s) failed`); process.exit(1); }
console.log("all views pass");
