// Mobile layout regression: no horizontal overflow and no iOS-autozoom inputs.
// Usage: npm run ui:build && node e2e/mobile-layout.mjs [screenshotDir]
// Needs Playwright + Chromium (not a repo dependency; resolved from node_modules
// or the PLAYWRIGHT_MODULE env var). Exits non-zero on any violation.
import { createRequire } from "node:module";
import fs from "node:fs";
import { startMock } from "./mock-console.mjs";

const require = createRequire(import.meta.url);
let pw;
for (const spec of [process.env.PLAYWRIGHT_MODULE, "playwright", "/home/ubuntu/node_modules/playwright"].filter(Boolean)) {
  try { pw = require(spec); break; } catch { /* try next */ }
}
if (!pw) { console.error("playwright not found (set PLAYWRIGHT_MODULE)"); process.exit(2); }
const { chromium, devices } = pw;
const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });

const WIDTHS = { 360: devices["Pixel 7"], 390: devices["iPhone 14"], 414: devices["iPhone 11 Pro Max"] };
const ROUTES = [["wire", ""], ["classic", "#classic"], ["deck", "#deck"]];

// Elements that straddle a viewport edge (partly visible, partly clipped) and are
// not inside a deliberate horizontal scroller. Fully off-screen slide-in panes
// (translateX) are fine; clipped-but-reachable content is the bug.
function measure() {
  const vw = window.innerWidth;
  // Content is fine inside a deliberate scroller (overflow auto/scroll that fits the
  // viewport) or a nowrap marquee/ellipsis clip. Clipping by a layout shell such as
  // .app{overflow:hidden} is the bug itself, so it does not count as containment.
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); const r = p.getBoundingClientRect(); if (r.left < -1 || r.right > vw + 1) continue; if (cs.overflowX === "auto" || cs.overflowX === "scroll" || (cs.overflowX === "hidden" && cs.whiteSpace === "nowrap")) return true; } return false; };
  const label = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : ""}`;
  const clipped = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
    const cs = getComputedStyle(el); if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if ((r.right > vw + 1 && r.left < vw - 1) || (r.left < -1 && r.right > 1)) { if (!inScroller(el)) clipped.push(`${label(el)}[${Math.round(r.left)}..${Math.round(r.right)}]`); }
  }
  const small = [...document.querySelectorAll("input,textarea,select")].filter((e) => e.offsetParent && !/^(checkbox|radio|range|hidden|file)$/.test(e.type) && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => `${label(e)}:${getComputedStyle(e).fontSize}`);
  const de = document.documentElement;
  return { vw, scrollW: Math.max(de.scrollWidth, document.body.scrollWidth), clipped: clipped.slice(0, 8), small };
}

const { srv, port } = await startMock();
const browser = await chromium.launch();
let failures = 0;
const report = [];
for (const [w, prof] of Object.entries(WIDTHS)) {
  for (const [name, hash] of ROUTES) {
    const ctx = await browser.newContext({ ...prof, viewport: { width: +w, height: 780 } });
    await ctx.addInitScript(() => { localStorage.setItem("ekho.operator.token", "t"); localStorage.setItem("ekho.operator.fleetId", "f1"); localStorage.setItem("ekho.operator.email", "m@example.com"); });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/ui/${hash}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const views = [["list", null]];
    if (name === "wire") views.push(["chat", async () => { await page.locator(".sidebar button, .sidebar [role=button]").filter({ hasText: /Jarvis|hash/ }).first().click(); await page.waitForTimeout(500); }]);
    for (const [view, enter] of views) {
      if (enter) await enter();
      const m = await page.evaluate(measure);
      const bad = m.scrollW > m.vw || m.clipped.length || m.small.length;
      report.push({ w, name, view, ...m, ok: !bad });
      if (bad) failures++;
      console.log(`${bad ? "FAIL" : "ok  "} ${w}px ${name}/${view}: scrollW=${m.scrollW} clipped=${JSON.stringify(m.clipped)} smallInputs=${JSON.stringify(m.small)}`);
      if (shots && w === "390") await page.screenshot({ path: `${shots}/390-${name}-${view}.png` });
    }
    await ctx.close();
  }
}
await browser.close(); srv.close();
if (shots) fs.writeFileSync(`${shots}/results.json`, JSON.stringify(report, null, 1));
if (failures) { console.error(`${failures} view(s) failed`); process.exit(1); }
console.log("all views pass");
