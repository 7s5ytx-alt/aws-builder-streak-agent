// Exercises the REAL wishlist voting code against your own signed-in Chrome.
//
//   npm run test:wishlist            find wishes and vote buttons, DON'T click
//   npm run test:wishlist -- --vote  cast one real vote
//
// Voting is OFF by default, and for a sharper reason than the other tests.
// The vote control is a toggle with no voted-state in the DOM: clicking a
// wish this account already voted for REMOVES that vote. A careless test run
// could undo a week that had already been earned.
//
// The dry run still proves the parts that can break: reading the wishes,
// pulling the vote count out of each label, and resolving the right button
// for a given wish.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findWishesOnPage, voteOnWishOnPage } from "../src/wishlist.ts";

const REALLY_VOTE = process.argv.includes("--vote");

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((candidate) => existsSync(candidate));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

const context = await chromium.launchPersistentContext(resolve("local-browser-profile"), {
  executablePath: CHROME, headless: false, viewport: null, args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://builder.aws.com/wishlist", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4500);

if (await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false)) {
  console.error("Signed out - run `npm run test:search` first to sign in.");
  await context.close();
  process.exit(1);
}
console.log("signed in\n");

console.log(REALLY_VOTE
  ? "*** --vote given: ONE REAL vote will be cast ***\n"
  : "dry run - vote buttons will be found but NOT clicked\n");

const wishes = await findWishesOnPage(page, 25);
console.log(`--- ${wishes.length} wishes, fewest votes first ---`);
for (const wish of wishes.slice(0, 12)) {
  console.log(`  ${String(wish.votes).padStart(3)} votes  ${wish.title.slice(0, 56)}`);
}

if (wishes.length === 0) {
  console.error("\nNo wishes found - the page markup may have changed.");
  await context.close();
  process.exit(1);
}

// Only ever touch ONE, even in a dry run: each click is a real state change.
// --match picks a specific wish by title instead of the fewest-votes default,
// so a real vote can be aimed at something worth supporting.
const matchIndex = process.argv.indexOf("--match");
const match = matchIndex >= 0 ? process.argv[matchIndex + 1] : undefined;
const target = match
  ? wishes.find((wish) => wish.title.toLowerCase().includes(match.toLowerCase()))
  : wishes[0];
if (!target) {
  console.error(`\nNo wish matched "${match}".`);
  await context.close();
  process.exit(1);
}
console.log(`\n${target.url}`);
console.log(`\n--- target: ${target.title.slice(0, 56)} ---`);
const outcome = await voteOnWishOnPage(page, target.url, {
  click: REALLY_VOTE,
  log: (line) => console.log("  · " + line),
});

console.log("\n=> " + outcome.toUpperCase());
console.log({
  "ready-not-clicked": "\nWORKS. The wish's own vote button was found and its count read.",
  voted: "\nVOTED. The count went up by one.",
  "already-voted": "\nAlready voted. The click removed it and it was put back - no harm done.",
  "unvoted-and-restored": "\nWARNING: a vote was removed and the restore did not read back cleanly.\nCheck this wish in the browser.",
  "not-found": "\nNo vote button could be resolved for this wish.",
}[outcome] ?? "\nUnexpected outcome - see above.");

await page.waitForTimeout(6000);
await context.close();
