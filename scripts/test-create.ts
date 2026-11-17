// Exercises the REAL wish / post / article creation code against your own
// signed-in Chrome, using no Cloudflare budget.
//
//   npm run test:create -- wish          fill the form, DON'T submit
//   npm run test:create -- post
//   npm run test:create -- article
//   npm run test:create -- wish --publish    actually publish it
//
// Publishing is OFF by default. These forms put content on a real profile
// under a real name, which is not something a test should do by accident.
//
// One honest caveat for `article`: opening the article editor creates a draft
// immediately, before anything is typed. A dry run therefore leaves an unsaved
// draft behind even though it publishes nothing.

import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createArticle, createPost, createWish } from "../src/create.ts";

const KIND = process.argv[2];
const PUBLISH = process.argv.includes("--publish");

if (!KIND || !["wish", "post", "article"].includes(KIND)) {
  console.error("usage: npm run test:create -- <wish|post|article> [--publish] [contentFile.json]");
  process.exit(1);
}

// Content comes from a JSON file when given, so punctuation survives the shell
// intact - the same mangling that once stored a carriage return inside an API
// token and cost an afternoon.
const fileArg = process.argv.find((arg) => arg.endsWith(".json"));
const content = fileArg
  ? JSON.parse(readFileSync(fileArg, "utf8")) as { title: string; description?: string; body?: string }
  : null;

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((candidate) => existsSync(candidate));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

const context = await chromium.launchPersistentContext(resolve("local-browser-profile"), {
  executablePath: CHROME, headless: false, viewport: null, args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
if (await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false)) {
  console.error("Signed out - run `npm run test:search` first to sign in.");
  await context.close();
  process.exit(1);
}

console.log(PUBLISH
  ? `*** --publish given: this ${KIND} will be PUBLISHED publicly ***\n`
  : `dry run - the ${KIND} form will be filled but NOT submitted\n`);

const log = (line: string) => console.log("  · " + line);
const submit = PUBLISH;
let outcome: string;

if (KIND === "wish") {
  const wish = content ?? {
    title: "AWS Emulator: an optional IAM enforcement mode for local testing",
    description: "The emulator does not enforce IAM, so a call that real AWS would deny succeeds locally. That is the right default for speed, but it means a permissions mistake is only discovered after deploying. An optional strict mode that evaluated the policies attached to the configured principal, even approximately, would let a test suite catch a missing permission on a developer machine rather than in a pipeline running against a real account.",
  };
  console.log(`title: ${wish.title}\n`);
  outcome = await createWish(page, { title: wish.title, description: wish.description ?? "", category: "develop", service: "IAM" }, { submit, log });
} else if (KIND === "post") {
  const post = content ?? {
    title: "What finally fixed your flaky browser automation?",
    body: "I spent two days on a selector that matched the wrong element on every page - it looked right, it was visible, and it silently did nothing. What eventually helped was anchoring on the one control that could not be ambiguous and working outward from it. Curious what the equivalent fix was for other people: the thing that turned an intermittent failure into a reliable one.",
  };
  console.log(`title: ${post.title}\n`);
  outcome = await createPost(page, { title: post.title, body: post.body ?? "" }, { submit, log });
} else {
  const article = content ?? {
    title: "Verifying browser automation: check the page, not your own click",
    description: "Why an automation that reports success can still be doing nothing, and the three checks that make a run trustworthy.",
    body: "An automated click that fails rarely throws. The element is found, the call returns, and the script moves on believing the work is done. Three habits turn that quiet failure into a loud one.\n\nFirst, verify through the page's own state rather than the return value of your click. A like button that carries aria-pressed will flip it to true; a Submit button that is disabled until a rich-text editor holds real content will enable itself. Those are the site telling you the action registered, which is a different and much stronger claim than your script telling you it tried.\n\nSecond, name every stopping point separately. A single boolean cannot distinguish a closed comment form from a selector that matched the wrong element, and those need opposite fixes. Distinct outcomes make the logs diagnostic instead of merely reassuring.\n\nThird, anchor on what cannot be ambiguous. Searching for an element by what it looks like fails the moment a page renders something similar elsewhere - and pages do, far more often than you would expect. Find the one control that is unique, then work outward to its neighbours.",
  };
  console.log(`title: ${article.title}\n`);
  outcome = await createArticle(page, {
    title: article.title,
    description: article.description ?? "",
    body: article.body ?? "",
    tag: "automation",
  }, { submit, log });
}

// A failed publish that shows no dialog and no error text has nothing left to
// read in the DOM, so capture what a person would see instead.
if (outcome !== "published" && outcome !== "ready-not-published") {
  const shot = resolve("publish-failure.png");
  await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);
  console.log(`\nscreenshot: ${shot}`);
}

console.log("\n=> " + outcome.toUpperCase());
console.log(outcome === "ready-not-published"
  ? "\nWORKS. Every field was filled and verified. Nothing was submitted."
  : outcome === "published"
    ? "\nPUBLISHED. The editor navigated away to the published item."
    : "\nDid not get there - the outcome above says which step stopped it.");

await page.waitForTimeout(10_000);
await context.close();
