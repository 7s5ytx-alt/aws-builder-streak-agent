// Reads back one published wish and prints the facts worth checking: the
// service it is filed under, its vote count, and its comment count.
//
//   npm run verify:wish -- <url>   (VERIFY_TERMS=a,b,c to change what is looked for)
//
// A plain HTTP fetch returns only the app shell, because the page is rendered
// in the browser - so this uses the signed-in Chrome profile like everything
// else here.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const WISH_URL = process.argv.find((arg) => arg.startsWith("https://"));
if (!WISH_URL) { console.error("usage: npm run verify:wish -- <url>   (VERIFY_TERMS=a,b,c to change what is looked for)"); process.exit(1); }

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

// Read env in Node, not in the page: evaluate runs in the browser, where
// `process` does not exist.
const TERMS = (process.env.VERIFY_TERMS ?? "Tools & SDKs,Amazon CodeCatalyst,Developer Tools")
  .split(",").map((entry) => entry.trim()).filter(Boolean);

console.log(await page.evaluate((names) => {
  // Search the WHOLE page: an article renders its tags outside <main>, so
  // scoping to main reported both the old and new tag as absent.
  const text = document.body.innerText;
  const out: string[] = [];
  for (const name of names) {
    out.push(`   ${text.includes(name) ? "PRESENT" : "absent "}  ${name}`);
  }
  const vote = document.querySelector('button[aria-label^="Vote for this wish"], button[aria-label^="Remove vote"]');
  out.push(`\n   vote control: "${vote?.getAttribute("aria-label") ?? "(none)"}"`);
  const comments = document.querySelector('button[aria-label^="Comments on wish"]');
  out.push(`   comments:     "${comments?.getAttribute("aria-label") ?? "(none)"}"`);
  return out.join("\n");
}, TERMS).catch((error) => "   read failed: " + (error instanceof Error ? error.message.split("\n")[0] : String(error))));

await context.close();
