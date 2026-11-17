// Diagnostic only. Reports how the Wishlist page is built: the vote controls
// on each idea, and the control that starts a new wish.
//
//   npm run probe:wishlist
//
// Written rather than guessed because every selector assumed from the outside
// in this project has been wrong, most expensively the comment box, which
// matched the article body on every page for two days.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
await page.waitForTimeout(5000);

console.log("URL: " + page.url());
console.log("signed out? " + await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false));

console.log("\n--- every button, grouped by aria-label shape ---");
console.log(await page.evaluate(() => {
  const seen = new Map<string, { count: number; sample: string }>();
  for (const button of document.querySelectorAll("button")) {
    const label = button.getAttribute("aria-label") ?? "";
    const text = (button.textContent ?? "").trim().slice(0, 24);
    // Collapse "Vote for X 12" style labels to their prefix so the list stays
    // readable when a page has fifty ideas.
    const shape = label.replace(/\s+\d+\s*$/, "").split(",")[0]!.slice(0, 44) || `(no label) "${text}"`;
    const entry = seen.get(shape) ?? { count: 0, sample: "" };
    entry.count += 1;
    if (!entry.sample) {
      entry.sample = `label="${label.slice(0, 60)}" pressed=${button.getAttribute("aria-pressed")} text="${text}" disabled=${button.hasAttribute("disabled")}`;
    }
    seen.set(shape, entry);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([shape, entry]) => `  ${String(entry.count).padStart(3)}x  ${shape}\n         ${entry.sample}`)
    .join("\n");
}));

console.log("\n--- links that look like individual ideas ---");
console.log(await page.evaluate(() => {
  const hrefs = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
    .map((a) => a.getAttribute("href") ?? "")
    .filter((href) => /wish|idea|feature/i.test(href));
  return [...new Set(hrefs)].slice(0, 12).join("\n  ") || "  (none)";
}));

console.log("\n--- headings and tabs ---");
console.log(await page.evaluate(() =>
  [...document.querySelectorAll('h1, h2, [role="tab"]')]
    .map((el) => `  <${el.tagName.toLowerCase()}${el.getAttribute("role") ? " role=tab" : ""}> ${(el.textContent ?? "").trim().slice(0, 56)}`)
    .slice(0, 20).join("\n")));

console.log("\nBrowser stays open 60s so you can look.");
await page.waitForTimeout(60_000);
await context.close();
