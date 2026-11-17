// Exercises the REAL search-and-like code against your own signed-in Chrome,
// using no Cloudflare Browser Run budget at all.
//
//   npm run test:search          find articles, locate each like button, DON'T click
//   npm run test:search -- --like   actually like them (real, public)
//
// It imports src/feed.ts - the same module production uses - so what passes
// here is what runs on the schedule.
//
// Liking is OFF by default. The dry run still proves everything that can
// break: driving the search overlay, scoping to the results panel, reading
// the comment counts, and finding each card's own like button in a ready
// state. Putting likes on strangers' articles to test a selector is not a
// fair trade; pass --like when you mean it.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { likeInFeedOnPage, searchManyOnPage } from "../src/feed.ts";

// Same keyword list the scheduled run uses, so a pass here means a pass there.
const QUERIES = (process.env.SEARCH_QUERIES?.trim()
  ? process.env.SEARCH_QUERIES.split(",").map((entry) => entry.trim()).filter(Boolean)
  : ["articles", "comment to comment", "help for comments", "aws free comments", "help for aws certification"]);
const REALLY_LIKE = process.argv.includes("--like");
const MAX = Number(process.env.TEST_MAX ?? 3);

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((candidate) => existsSync(candidate));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

const context = await chromium.launchPersistentContext(resolve("local-browser-profile"), {
  executablePath: CHROME, headless: false, viewport: null, args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(3500);

// Several of Builder Center's auth cookies are session cookies, discarded when
// the browser closes, so this profile may be signed out. Pause rather than
// sending you off to another command.
let signedOut = await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false);
if (signedOut) {
  console.log("=".repeat(66));
  console.log("  This Chrome is signed OUT. Sign in to Builder Center in the window,");
  console.log("  then press Enter here.");
  console.log("=".repeat(66));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("\n  Press Enter once signed in... ");
  rl.close();
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2500);
  signedOut = await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false);
  if (signedOut) { console.error("\nStill signed out - stopping."); await context.close(); process.exit(1); }
}
console.log("signed in\n");

console.log(REALLY_LIKE
  ? "*** --like given: these likes are REAL and public ***\n"
  : "dry run - like buttons will be found but NOT clicked\n");

// Likes happen HERE, inside the search, while each query's own results are
// still rendered. Liking from the merged list afterwards returns not-found
// for everything the last query did not also match - which is exactly what
// this test reported before the callback existed.
const tally: Record<string, number> = {};
let liked = 0;
const likeFromPanel = async (panel: Array<{ url: string; title: string }>) => {
  for (const result of panel) {
    if (liked >= MAX) return;
    const outcome = await likeInFeedOnPage(page, result.url, { click: REALLY_LIKE });
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    console.log(`  ${outcome.toUpperCase().padEnd(20)} ${result.title.slice(0, 44)}`);
    if (outcome === "not-found") continue;
    liked += 1;
  }
};

const results = await searchManyOnPage(page, QUERIES, 20, (line) => console.log("  · " + line), likeFromPanel);

console.log(`\n--- merged across ${QUERIES.length} keyword(s), busiest first ---`);
for (const result of results.slice(0, 10)) {
  console.log(`  ${String(result.comments).padStart(4)} comments  ${result.title.slice(0, 58)}`);
}

if (results.length === 0) {
  console.log("\nNo results. The search overlay did not produce an Articles panel.");
  await context.close();
  process.exit(1);
}

console.log("\n" + "=".repeat(66));
for (const [outcome, count] of Object.entries(tally)) console.log(`  ${outcome.padEnd(22)} ${count}`);

const good = (tally["ready-not-clicked"] ?? 0) + (tally.liked ?? 0) + (tally["already-liked"] ?? 0);
console.log("");
console.log(good === MAX
  ? "WORKS. Search drove the overlay, results were scoped and ranked, and every\nlike button was found in a ready state."
  : "Some cards did not yield a like button - see the outcomes above.");

await context.close();
