// Corrects the AWS service on an already-published wish.
//
//   npm run fix:wish -- <wishUrl>            open the editor, DON'T save
//   npm run fix:wish -- <wishUrl> --save     save the correction
//
// The first publish attached "Amazon CodeCatalyst" because the service filter
// typed "IAM", nothing matched, and the code fell back to the first option in
// the list. The fallback kept a required field from blocking the publish,
// which was right, but it put an inaccurate service on a public post.
//
// There is no Edit button on the wish page itself; it lives in the overflow
// menu, which this script opens and reports before touching anything.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const WISH_URL = process.argv.find((arg) => arg.startsWith("https://"));
const SAVE = process.argv.includes("--save");
if (!WISH_URL) {
  console.error("usage: npm run fix:wish -- <wishUrl> [--save]");
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

await page.goto(WISH_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

const overflow = page.getByRole("button", { name: /^show more,/i }).first();
if (!(await overflow.isVisible().catch(() => false))) {
  console.error("No overflow menu found on the wish page.");
  await context.close();
  process.exit(1);
}
await overflow.click({ timeout: 8000 });
await page.waitForTimeout(1800);

console.log("--- overflow menu ---");
console.log(await page.evaluate(() =>
  [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] a')]
    .map((el) => `   "${(el.textContent ?? "").trim().slice(0, 40)}" href=${el.getAttribute("href") ?? "-"}`)
    .join("\n") || "   (nothing)"));

const edit = page.getByRole("menuitem", { name: /edit/i }).first();
const editFallback = page.getByRole("button", { name: /^\s*edit\s*$/i }).first();
const target = (await edit.isVisible().catch(() => false)) ? edit : editFallback;
if (!(await target.isVisible().catch(() => false))) {
  console.error("\nNo Edit option in the menu - the service may not be editable after publishing.");
  await page.waitForTimeout(20_000);
  await context.close();
  process.exit(1);
}

await target.click({ timeout: 8000 });
await page.waitForTimeout(5000);
console.log("\neditor at: " + page.url());

// Report what the service dropdown actually offers, rather than guessing a
// label again. "IAM" matched nothing; the list almost certainly spells it out.
const serviceButton = page.getByRole("button", { name: /aws service|codecatalyst/i }).first();
if (!(await serviceButton.isVisible().catch(() => false))) {
  console.error("No AWS service control found in the editor.");
  await page.waitForTimeout(20_000);
  await context.close();
  process.exit(1);
}
await serviceButton.click({ timeout: 8000 });
await page.waitForTimeout(1800);

// Look at the list BEFORE typing. Two filter attempts ("IAM", then
// "identity") matched nothing, which says the typing is not reaching a search
// box rather than that the service is absent - so read what is actually
// offered, and how, instead of guessing at a third spelling.
console.log("\n--- the dropdown as opened ---");
console.log(await page.evaluate(() => {
  const options = [...document.querySelectorAll('[role="option"], [role="menuitem"]')];
  const boxes = [...document.querySelectorAll('input:not([type="hidden"]), [role="combobox"], [role="searchbox"]')]
    .filter((el) => el.getBoundingClientRect().height > 0)
    .map((el) => `   search box: <${el.tagName.toLowerCase()}> role=${el.getAttribute("role")} placeholder="${el.getAttribute("placeholder") ?? ""}"`);
  return [
    `   ${options.length} option(s)`,
    ...boxes,
    ...options.slice(0, 25).map((el) => `     "${(el.textContent ?? "").trim().slice(0, 48)}"`),
  ].join("\n");
}));

// Select by exact option text. Typing does not filter this dropdown - the
// list was identical before and after - and the list is scoped to the chosen
// category anyway, so "IAM" was never going to appear under Developer Tools.
// With only 22 options, matching the text directly is both simpler and
// deterministic.
const WANTED = process.argv.includes("--service")
  ? process.argv[process.argv.indexOf("--service") + 1]!
  : "Tools & SDKs";

const option = page.locator('[role="option"], [role="menuitem"]')
  .filter({ hasText: new RegExp(`^\\s*${WANTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") })
  .first();

if (await option.isVisible().catch(() => false)) {
  await option.click({ timeout: 5000 });
  await page.waitForTimeout(1200);
  console.log(`\nselected: ${WANTED}`);
} else {
  console.error(`\n"${WANTED}" is not in this category's list - nothing changed.`);
  await page.waitForTimeout(20_000);
  await context.close();
  process.exit(1);
}

if (!SAVE) {
  console.log("\nDRY RUN - not saving. Re-run with --save to keep this change.");
  await page.waitForTimeout(25_000);
  await context.close();
  process.exit(0);
}

const save = page.getByRole("button", { name: /^\s*(save|update|submit|publish)\s*$/i }).last();
if (!(await save.isVisible().catch(() => false))) {
  console.error("No save control found.");
  await context.close();
  process.exit(1);
}
await save.click({ timeout: 8000 });
await page.waitForTimeout(4000);
console.log("url after saving: " + page.url());
console.log(/\/wishlist\//.test(page.url()) && !/edit/i.test(page.url()) ? "SAVED." : "Still in the editor - check the browser.");

await page.waitForTimeout(8000);
await context.close();
