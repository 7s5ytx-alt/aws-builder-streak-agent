// Diagnostic only. Drives Builder Center's search the way a person does, then
// reports the URL it landed on and the markup of the result cards - the two
// facts needed to source articles from search and like them without opening
// each one. Guessing either would repeat the mistake that cost this project
// two days.
//
//   npm run probe:search

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((c) => existsSync(c));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

const context = await chromium.launchPersistentContext(resolve("local-browser-profile"), {
  executablePath: CHROME, headless: false, viewport: null, args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

console.log("--- candidate search inputs ---");
console.log(await page.evaluate(() =>
  [...document.querySelectorAll("input")]
    .map((i, n) => `[${n}] type=${i.type} role=${i.getAttribute("role")} placeholder="${i.placeholder}" aria-label="${i.getAttribute("aria-label")}" visible=${i.getBoundingClientRect().height > 0}`)
    .join("\n")));

// The page renders the search field twice (a desktop one and a mobile one),
// and .first() picked the hidden copy. Ask Playwright which is actually
// visible instead of assuming DOM order matches what a person sees.
const boxes = page.locator('input[type="search"], input[role="searchbox"], input[placeholder*="earch"]');
let box = null;
for (let i = 0; i < (await boxes.count()); i += 1) {
  const candidate = boxes.nth(i);
  if (await candidate.isVisible().catch(() => false)) { box = candidate; console.log(`\nusing search input #${i}`); break; }
}
if (box) {
  await box.click();
  await page.keyboard.type("articles", { delay: 30 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  console.log("\nURL after searching: " + page.url());
} else {
  console.log("\nNo search input found - could not search.");
}

// The Articles tab may need an explicit click.
const tab = page.getByRole("tab", { name: /^\s*articles\s*$/i }).first();
if (await tab.isVisible().catch(() => false)) {
  await tab.click().catch(() => undefined);
  await page.waitForTimeout(2500);
  console.log("clicked Articles tab -> " + page.url());
}

console.log("\n--- first 3 result cards ---");
console.log(await page.evaluate(() => {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/content/"]')];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of links) {
    if (seen.has(a.href) || seen.size >= 3) continue;
    seen.add(a.href);
    // Walk up to the card that holds this link's own action buttons.
    let card: HTMLElement | null = a;
    for (let d = 0; d < 10 && card; d += 1) {
      const buttons = [...card.querySelectorAll("button")];
      // A real result card is identified by its OWN like control, not by
      // having some buttons: the home page wraps cards in a carousel whose
      // slide arrows matched a plain count check.
      if (buttons.some((b) => /^like /i.test(b.getAttribute("aria-label") ?? ""))) {
        out.push(`\nTITLE: ${(a.textContent ?? "").trim().slice(0, 70)}`);
        out.push(`URL:   ${a.href}`);
        out.push(`CARD:  depth ${d}, <${card.tagName.toLowerCase()}> class="${card.className.toString().slice(0, 60)}"`);
        buttons.forEach((b, i) => out.push(
          `   btn[${i}] aria-label="${b.getAttribute("aria-label")}"`
          + ` aria-pressed="${b.getAttribute("aria-pressed")}"`
          + ` text="${(b.textContent ?? "").trim().slice(0, 20)}"`));
        break;
      }
      card = card.parentElement;
    }
  }
  return out.join("\n");
}));

console.log("\nBrowser stays open 45s.");
await page.waitForTimeout(45_000);
await context.close();
