// Replaces the tag on an already-published article.
//
//   npm run fix:tag -- <articleUrl> <tag>            open the editor, DON'T save
//   npm run fix:tag -- <articleUrl> <tag> --save     save the correction
//
// The first publish attached "active-directory" to an article about browser
// automation. The tag dropdown is virtualized: it renders only the first 24
// entries, all beginning with "a", so matching option text alone can never
// reach a tag further down the alphabet. Typing into the dropdown's combobox
// loads the matching entries - which is the same fix now in src/create.ts.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ARTICLE_URL = process.argv.find((arg) => arg.startsWith("https://"));
const TAG = process.argv.find((arg) => !arg.startsWith("-") && !arg.startsWith("https://") && !arg.includes("\\") && !arg.includes("/") && arg !== "article");
const SAVE = process.argv.includes("--save");
if (!ARTICLE_URL || !TAG) {
  console.error("usage: npm run fix:tag -- <articleUrl> <tag> [--save]");
  process.exit(1);
}

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((candidate) => existsSync(candidate));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

const context = await chromium.launchPersistentContext(resolve("local-browser-profile"), {
  executablePath: CHROME, headless: false, viewport: null, args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto(ARTICLE_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

const overflow = page.getByRole("button", { name: /^show more,/i }).first();
if (!(await overflow.isVisible().catch(() => false))) {
  console.error("No overflow menu on the article page.");
  await context.close();
  process.exit(1);
}
await overflow.click({ timeout: 8000 });
await page.waitForTimeout(1800);

const edit = page.getByRole("menuitem", { name: /edit/i }).first();
if (!(await edit.isVisible().catch(() => false))) {
  console.error("No Edit option in the menu.");
  await context.close();
  process.exit(1);
}
await edit.click({ timeout: 8000 });
await page.waitForTimeout(6000);
console.log("editor at: " + page.url());

const tagsControl = page.getByRole("button", { name: /choose tags|active-directory/i }).first();
if (!(await tagsControl.isVisible().catch(() => false))) {
  console.error("No tags control found in the editor.");
  await context.close();
  process.exit(1);
}
await tagsControl.click({ timeout: 8000 });
await page.waitForTimeout(1500);

// Remove the wrong tag first, if the editor offers a dismiss control for it.
const removeWrong = page.getByRole("button", { name: /remove.*active-directory|active-directory.*remove/i }).first();
if (await removeWrong.isVisible().catch(() => false)) {
  await removeWrong.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
  console.log("removed active-directory");
}

const search = page.locator('[role="combobox"]').filter({ visible: true }).last();
const listOptions = async () => page.evaluate(() =>
  [...document.querySelectorAll('[role="option"], [role="menuitem"]')]
    .map((el) => (el.textContent ?? "").trim())
    .filter((text) => text.length > 0));

console.log("\n--- before typing ---");
console.log("   " + ((await listOptions()).slice(0, 8).join(", ") || "(none)"));

// TAG may be a comma-separated list of candidates. One run per guess is far
// too slow when the list is virtualized and only reveals itself as you type,
// so try them all and report which actually exist.
const candidates = TAG.split(",").map((entry) => entry.trim()).filter(Boolean);
let wanted = page.locator('[role="option"]').first();
let chosen = "";

for (const candidate of candidates) {
  if (!(await search.isVisible().catch(() => false))) break;
  await search.fill("").catch(() => undefined);
  await page.waitForTimeout(600);
  await search.fill(candidate).catch(() => undefined);
  await page.waitForTimeout(1800);

  const offered = await listOptions();
  console.log(`   "${candidate}" -> ${offered.length ? offered.slice(0, 6).join(", ") : "(no matches)"}`);

  const exact = page.locator('[role="option"], [role="menuitem"]')
    .filter({ hasText: new RegExp(`^\\s*${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") })
    .first();
  if (await exact.isVisible().catch(() => false)) { wanted = exact; chosen = candidate; break; }

  // Fall back to any offered option that contains the candidate - a close
  // relative is far better than an unrelated tag from the top of the list.
  const loose = page.locator('[role="option"], [role="menuitem"]').first();
  if (offered.length > 0 && (await loose.isVisible().catch(() => false))) {
    wanted = loose;
    chosen = offered[0]!;
    break;
  }
}

if (!chosen) {
  console.error(`\nNone of ${candidates.join(", ")} is offered - nothing changed.`);
  await page.waitForTimeout(20_000);
  await context.close();
  process.exit(1);
}
const TAG_CHOSEN = chosen;
await wanted.click({ timeout: 5000 });
await page.waitForTimeout(1200);
console.log(`\nselected: ${TAG_CHOSEN}`);

if (!SAVE) {
  console.log("\nDRY RUN - not saving. Re-run with --save to keep this change.");
  await page.waitForTimeout(20_000);
  await context.close();
  process.exit(0);
}

const publish = page.locator("button").filter({ hasText: /^\s*(publish|save|update)\s*$/i }).filter({ visible: true }).last();
await publish.click({ timeout: 8000 }).catch(() => undefined);
await page.waitForTimeout(3000);

// Re-publishing runs the same pre-publish checks as the first time.
const cancel = page.getByRole("button", { name: /^\s*cancel\s*$/i }).last();
if (await cancel.isVisible().catch(() => false)) {
  console.log("pre-publish checks running");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const confirm = page.locator("button").filter({ hasText: /^\s*(publish|continue|confirm|post)\s*$/i }).filter({ visible: true }).last();
    if ((await confirm.isVisible().catch(() => false)) && !(await confirm.isDisabled().catch(() => true))) {
      await confirm.click({ timeout: 8000 }).catch(() => undefined);
      console.log("confirmed");
      break;
    }
    await page.waitForTimeout(2000);
  }
}

await page.waitForTimeout(5000);
console.log("url after saving: " + page.url());
console.log(/\/content\//.test(page.url()) && !/\/create\//.test(page.url()) ? "SAVED." : "Still in the editor - check the browser.");

await page.waitForTimeout(6000);
await context.close();
