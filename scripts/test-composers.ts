// Opens N articles in a row and runs the FULL comment chain on each, stopping
// just before Submit. Nothing is ever posted.
//
//   npm run test:composers            10 articles from search
//   TEST_MAX=20 npm run test:composers
//
// Why this exists: one article succeeding proves the composer can be found
// once, not that it is found reliably. The failure this replaces looked fine
// on a single article too - the old code matched the article body, which also
// exists on every page. A run of ten says whether the fix generalises or
// whether it got lucky.
//
// It deliberately does NOT stop at the first success, unlike test-comment.ts.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { postCommentOnPage } from "../src/comment.ts";
import { searchManyOnPage } from "../src/feed.ts";

// Never submitted, but still written as something a person could have typed:
// a draft left sitting in a box on a real article should not read as spam if
// anyone happens to look over your shoulder.
const SAMPLE =
  "Worth noting how much of this comes down to getting the environment right before anything else runs.";

// Same keyword list the scheduled run uses, so a pass here means a pass there.
const QUERIES = (process.env.SEARCH_QUERIES?.trim()
  ? process.env.SEARCH_QUERIES.split(",").map((entry) => entry.trim()).filter(Boolean)
  : ["articles", "comment to comment", "help for comments", "aws free comments", "help for aws certification"]);
const MAX = Number(process.env.TEST_MAX ?? 10);

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

let signedOut = await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false);
if (signedOut) {
  console.log("=".repeat(70));
  console.log("  Signed OUT. Sign in to Builder Center in the window, then press Enter.");
  console.log("=".repeat(70));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("\n  Press Enter once signed in... ");
  rl.close();
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2500);
  signedOut = await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false);
  if (signedOut) { console.error("\nStill signed out - stopping."); await context.close(); process.exit(1); }
}
console.log("signed in\n");

const results = await searchManyOnPage(page, QUERIES, MAX, (line) => console.log("  · " + line));
if (results.length === 0) { console.error("No search results."); await context.close(); process.exit(1); }

console.log(`\nNOTHING WILL BE SUBMITTED. Testing ${Math.min(MAX, results.length)} articles.\n`);

const tally: Record<string, number> = {};
const failures: string[] = [];
let index = 0;

for (const article of results.slice(0, MAX)) {
  index += 1;
  console.log("-".repeat(70));
  console.log(`${String(index).padStart(2)}. [${String(article.comments).padStart(4)} comments] ${article.title.slice(0, 50)}`);

  let outcome: string;
  try {
    await page.goto(article.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2500);
    outcome = await postCommentOnPage(page, SAMPLE, {
      articleUrl: article.url,
      submit: false,
      log: (line) => console.log("      · " + line),
    });
  } catch (error) {
    outcome = "error: " + (error instanceof Error ? error.message.split("\n")[0]!.slice(0, 70) : String(error));
  }

  console.log("    => " + outcome.toUpperCase());
  tally[outcome] = (tally[outcome] ?? 0) + 1;
  if (outcome !== "ready-not-submitted" && outcome !== "already-present") {
    failures.push(`${outcome}  ${article.url}`);
  }
}

console.log("\n" + "=".repeat(70));
for (const [outcome, count] of Object.entries(tally)) console.log(`  ${outcome.padEnd(26)} ${count}`);

const ready = tally["ready-not-submitted"] ?? 0;
console.log("");
console.log(`  ${ready} of ${index} articles reached an enabled Submit button.`);
if (failures.length > 0) {
  console.log("\n--- did not get there ---");
  for (const failure of failures) console.log("  " + failure);
}

await context.close();
