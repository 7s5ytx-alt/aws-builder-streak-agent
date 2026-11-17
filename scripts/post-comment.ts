// Posts ONE real comment to ONE article, using the production code path, from
// your own signed-in Chrome. No Cloudflare budget is used.
//
//   npm run post:comment -- <articleUrl> <commentFile>
//
// The comment text comes from a file rather than the command line so that
// quotes, backticks and punctuation survive PowerShell intact - the same class
// of mangling that put a carriage return inside CF_API_TOKEN and cost an
// afternoon.
//
// This one DOES submit. It is the deliberate counterpart to test-comment.ts,
// which never does.

import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { postCommentOnPage } from "../src/comment.ts";

const [articleUrl, commentFile] = process.argv.slice(2);
if (!articleUrl || !commentFile) {
  console.error("usage: npm run post:comment -- <articleUrl> <commentFile>");
  process.exit(1);
}
const comment = readFileSync(commentFile, "utf8").trim();
if (!comment) { console.error("The comment file is empty."); process.exit(1); }

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((candidate) => existsSync(candidate));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

console.log("POSTING THIS, FOR REAL:\n");
console.log("  " + comment.replace(/\n/g, "\n  "));
console.log("\nto " + articleUrl + "\n");

const context = await chromium.launchPersistentContext(resolve("local-browser-profile"), {
  executablePath: CHROME, headless: false, viewport: null, args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto(articleUrl, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

if (await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false)) {
  console.error("This Chrome is signed out - run `npm run test:search` first to sign in.");
  await context.close();
  process.exit(1);
}

const outcome = await postCommentOnPage(page, comment, {
  articleUrl,
  submit: true,
  log: (line) => console.log("  · " + line),
});

console.log("\n=> " + outcome.toUpperCase());
console.log(outcome === "verified-in-page"
  ? "\nPOSTED. The comment was found on the page after submitting."
  : outcome === "already-present"
    ? "\nThis exact comment was already on the article - nothing was posted."
    : "\nNOT posted. The outcome above says where it stopped.");

await page.waitForTimeout(8000);
await context.close();
