import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profileDir = resolve("local-browser-profile");
const builderHome = "https://builder.aws.com/";

if (!existsSync(chrome)) throw new Error(`Chrome was not found at ${chrome}`);

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: chrome,
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto(builderHome, { waitUntil: "domcontentloaded" });

console.log("Chrome is open. Sign in to AWS Builder Center yourself if needed.");
console.log("After you reach the Builder Center home page, this helper will queue up to 3 articles.");

const deadline = Date.now() + 8 * 60_000;
while (Date.now() < deadline) {
  await page.waitForTimeout(2_000);
  const url = page.url();
  if (/signin|sign-in|login|identity/i.test(url)) continue;
  const links = await page.locator('a[href*="/content/"]').evaluateAll((nodes) =>
    nodes.map((node) => ({ url: node.href, title: (node.textContent ?? "").trim() }))
      .filter((item) => item.url && item.title),
  );
  const articles = [...new Map(links.map((item) => [item.url, item])).values()].slice(0, 3);
  if (articles.length === 0) continue;

  console.log("Queued articles:");
  for (const [index, article] of articles.entries()) {
    console.log(`${index + 1}. ${article.title} — ${article.url}`);
    if (index > 0) await context.newPage().then((tab) => tab.goto(article.url, { waitUntil: "domcontentloaded" }));
  }
  await page.goto(articles[0].url, { waitUntil: "domcontentloaded" });
  console.log("Read the opened articles and add reactions/comments yourself. This helper does not post anything.");
  break;
}

console.log("Keep Chrome open while you use it. Press Ctrl+C in this terminal when finished.");
await new Promise(() => {});
