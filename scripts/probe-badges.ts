// Diagnostic only. Reports how each badge is represented in the DOM, so the
// daily report can name them and say which are unlocked.
//
//   npm run probe:badges
//
// The badge grid is images, not text: reading document.innerText returned the
// single word "Badges". Whatever identifies a badge and its locked state is
// in attributes, and this prints them rather than guessing.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((candidate) => existsSync(candidate));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

const context = await chromium.launchPersistentContext(resolve("local-browser-profile"), {
  executablePath: CHROME, headless: false, viewport: { width: 1400, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://builder.aws.com/profile?tab=badges", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

if (await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false)) {
  console.error("Signed out - run `npm run test:proof` first and sign in.");
  await context.close();
  process.exit(1);
}

// Dismiss the cookie banner first: it sits in the DOM as a dialog on every
// page and intercepted both the clicks and the inspection.
for (const name of [/accept all cookies/i, /^\s*accept\s*$/i]) {
  const accept = page.getByRole("button", { name }).first();
  if (await accept.isVisible().catch(() => false)) {
    await accept.click({ timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    console.log("dismissed the cookie banner");
    break;
  }
}

// Reveal every badge, so the proof is not just the first ten.
for (let round = 0; round < 6; round += 1) {
  const more = page.getByRole("button", { name: /load more/i }).first();
  if (!(await more.isVisible().catch(() => false))) break;
  await more.click({ timeout: 6000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  console.log(`clicked "Load more" (round ${round + 1})`);
}

console.log("\n--- every image in the badge area ---");
console.log(await page.evaluate(() => {
  const out: string[] = [];
  for (const img of [...document.querySelectorAll("img")]) {
    const rect = img.getBoundingClientRect();
    // Badge tiles are square and reasonably large; avatars and icons are not.
    if (rect.width < 40 || Math.abs(rect.width - rect.height) > 12) continue;
    const parent = img.closest("[class]") as HTMLElement | null;
    out.push(
      `  alt="${img.getAttribute("alt") ?? ""}"`
      + ` aria="${img.getAttribute("aria-label") ?? ""}"`
      + ` title="${img.getAttribute("title") ?? ""}"`
      + ` ${Math.round(rect.width)}px`
      + ` opacity=${getComputedStyle(img).opacity}`
      + ` filter=${getComputedStyle(img).filter.slice(0, 20)}`
      + ` parentClass="${(parent?.className ?? "").toString().slice(0, 40)}"`
      + `
      src=${(img.getAttribute("src") ?? "").split("/").pop()}`
      + ` parentFilter=${parent ? getComputedStyle(parent).filter.slice(0, 24) : "-"}`,
    );
  }
  return out.join("\n") || "  (no badge-shaped images found)";
}));

// Clicking a tile may open a panel with the real progress ("3 of 7 days"),
// which is far more useful than knowing a streak is merely in progress.
for (const target of ["7-Day Like Streak", "7-Day Comment Streak"]) {
  console.log(`\n=== clicking "${target}" ===`);
  const tile = page.locator(`img[alt="${target}"]`).first();
  if (!(await tile.isVisible().catch(() => false))) { console.log("   tile not visible"); continue; }
  await tile.scrollIntoViewIfNeeded().catch(() => undefined);
  const before = await page.evaluate(() => document.body.innerText);
  await tile.click({ timeout: 6000 }).catch((error) => console.log("   click failed: " + error.message.split("\n")[0]));
  await page.waitForTimeout(2500);

  // Diff the page text instead of guessing at a selector. The first attempt
  // matched [role="dialog"] and got the hidden cookie-consent dialog, which
  // is in the DOM on every page. Whatever the click reveals, it is text that
  // was not there a moment ago.
  console.log("   url now: " + page.url());
  const after = await page.evaluate(() => document.body.innerText);
  const fresh = after.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const previous = new Set(before.split("\n").map((line) => line.trim()));
  const appeared = [...new Set(fresh.filter((line) => !previous.has(line)))];
  console.log(appeared.length > 0
    ? "   NEW TEXT after the click:\n" + appeared.slice(0, 20).map((line) => "     " + line.slice(0, 80)).join("\n")
    : "   nothing new appeared");

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(1200);
}

console.log("\n--- anything with a badge-ish aria-label or title ---");
console.log(await page.evaluate(() =>
  [...document.querySelectorAll("[aria-label], [title]")]
    .map((el) => `${el.getAttribute("aria-label") ?? el.getAttribute("title") ?? ""}`)
    .filter((text) => /badge|streak|lock|day|wish|article|comment|photo|hello/i.test(text))
    .slice(0, 30).map((text) => "  " + text.slice(0, 70)).join("\n") || "  (none)"));

await page.screenshot({ path: resolve("streak-proof.png"), fullPage: false });
console.log(`\nscreenshot with everything loaded: ${resolve("streak-proof.png")}`);

await page.waitForTimeout(15_000);
await context.close();
