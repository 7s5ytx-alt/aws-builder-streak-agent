// Exercises the REAL comment-posting code against your own signed-in Chrome,
// using no Cloudflare Browser Run budget at all.
//
//   npm run test:comment
//
// It imports src/comment.ts - the same module production uses - so what passes
// here is what runs at 6am. A separate copy of the steps would drift, and
// every bug in this path so far has lived in a detail.
//
// IT NEVER SUBMITS. The run stops once the Submit button goes enabled and
// reports `ready-not-submitted`, which proves everything that can break:
// finding the composer, typing into Slate, and the text actually registering.
// Publishing a throwaway comment to a real article to prove a button works
// would not be a fair trade.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { postCommentOnPage } from "../src/comment.ts";

const SAMPLE =
  "The point about provisioned concurrency billing per GB-second regardless of invocation is the detail that decides whether it suits a given workload.";

const PROFILE_DIR = resolve("local-browser-profile");
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find((candidate) => existsSync(candidate));

if (!CHROME) {
  console.error("Chrome not found.");
  process.exit(1);
}

const only = process.argv[2];
const MAX = Number(process.env.TEST_MAX ?? 6);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: CHROME,
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(3500);

// Several of Builder Center's auth cookies have no expiry, which makes them
// session cookies: they live only while the browser is open and are discarded
// when it closes. So this profile is signed out every time a previous script
// finished. Rather than send you away to another command, pause here.
let signedOut = await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false);
if (signedOut) {
  console.log("=".repeat(66));
  console.log("  This Chrome is signed OUT (its session cookies died on last close).");
  console.log("  Sign in to Builder Center in the window, then press Enter here.");
  console.log("=".repeat(66));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("\n  Press Enter once signed in... ");
  rl.close();
  await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2500);
  signedOut = await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false);
  if (signedOut) {
    console.error("\nStill signed out — stopping.");
    await context.close();
    process.exit(1);
  }
}
console.log("signed in\n");

const articles: string[] = only
  ? [only]
  : await page
      .locator('a[href*="/content/"]')
      .evaluateAll((nodes) => [...new Set(nodes.map((n) => (n as HTMLAnchorElement).href))])
      .catch(() => []);

console.log(`testing up to ${MAX} of ${articles.length} articles — NOTHING WILL BE SUBMITTED\n`);

const tally: Record<string, number> = {};
let success = "";

for (const url of articles.slice(0, MAX)) {
  console.log("-".repeat(66));
  console.log(url.slice(0, 92));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2500);

    const outcome = await postCommentOnPage(page, SAMPLE, {
      articleUrl: url,
      submit: false,
      log: (line) => console.log("    · " + line),
    });

    console.log("  => " + outcome.toUpperCase());
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    if (outcome === "ready-not-submitted") { success = url; break; }
  } catch (error) {
    console.log("  => ERROR " + (error instanceof Error ? error.message.split("\n")[0].slice(0, 90) : String(error)));
    tally.error = (tally.error ?? 0) + 1;
  }
}

console.log("");
console.log("=".repeat(66));
for (const [outcome, count] of Object.entries(tally)) console.log(`  ${outcome.padEnd(24)} ${count}`);
console.log("");
console.log(success
  ? `WORKS. Composer opened, Slate accepted the text, Submit went enabled.\n  ${success}`
  : "No article got as far as an enabled Submit. The outcomes above say where each stopped.");

await context.close();
