// Diagnostic only. Reports how the three creation pages are built - wish,
// post and article - so the agent can fill them in without guessing at
// selectors. Each page is visited, its fields and submit controls listed, and
// NOTHING is ever typed or submitted.
//
//   npm run probe:create

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Paths may be given on the command line; /create/article turned out to be a
// 404, so the real article path has to be discovered from the Create menu.
const PAGES = process.argv.slice(2).filter((arg) => arg.startsWith("/"));
if (PAGES.length === 0) PAGES.push("/create/wish", "/create/post", "/create/article");

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((candidate) => existsSync(candidate));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

const context = await chromium.launchPersistentContext(resolve("local-browser-profile"), {
  executablePath: CHROME, headless: false, viewport: null, args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());

// `npm run probe:create -- menu` opens the Create dropdown and lists what it
// offers. Both /create and /create/article are 404s, so the article editor's
// real path is only discoverable from the menu itself.
if (process.argv.includes("menu")) {
  await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const create = page.getByRole("button", { name: /^\s*create\s*$/i }).first();
  await create.click({ timeout: 8000 }).catch((error) => console.log("click failed: " + error.message.split("\n")[0]));
  await page.waitForTimeout(2000);
  console.log("--- menu items ---");
  console.log(await page.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"], [role="menu"] a, [role="dialog"] a, [role="menu"] button')]
      .map((el) => `   <${el.tagName.toLowerCase()}> "${(el.textContent ?? "").trim().slice(0, 40)}" href=${el.getAttribute("href") ?? "-"}`)
      .join("\n") || "   (no menu items found)"));
  console.log("\n--- every visible link after opening the menu ---");
  console.log(await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .filter((a) => a.getBoundingClientRect().height > 0)
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => !/^#|^https?:\/\/(?!builder\.aws\.com)/.test(href))
      .slice(0, 40).join("\n   ")));
  await page.waitForTimeout(30_000);
  await context.close();
  process.exit(0);
}

for (const path of PAGES) {
  console.log("\n" + "=".repeat(70));
  console.log("  " + path);
  console.log("=".repeat(70));

  await page.goto("https://builder.aws.com" + path, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.waitForTimeout(4500);
  // A single-page app can re-render and destroy the execution context while
  // evaluate is running. Settling again and retrying once is enough.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  console.log("landed on: " + page.url());

  console.log(await page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) => el.getBoundingClientRect().height > 0;

    out.push("\n-- text fields --");
    for (const el of document.querySelectorAll<HTMLElement>('input, textarea, [contenteditable="true"]')) {
      if (!visible(el)) continue;
      const input = el as HTMLInputElement;
      const label = el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "";
      out.push(`   <${el.tagName.toLowerCase()}> type=${input.type ?? "-"} label="${label.slice(0, 44)}"`
        + ` ce=${el.isContentEditable} slate=${el.hasAttribute("data-slate-editor")}`
        + ` name="${input.name ?? ""}"`);
    }

    out.push("\n-- buttons --");
    for (const button of document.querySelectorAll("button")) {
      if (!visible(button)) continue;
      const label = button.getAttribute("aria-label") ?? "";
      const text = (button.textContent ?? "").trim().slice(0, 28);
      if (!label && !text) continue;
      if (/cookie|privacy|navigation|sub navigation/i.test(label + text)) continue;
      out.push(`   label="${label.slice(0, 40)}" text="${text}" disabled=${button.hasAttribute("disabled")}`);
    }

    out.push("\n-- links under /create --");
    const createLinks = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => /create|article|publish|draft/i.test(href));
    out.push("   " + ([...new Set(createLinks)].slice(0, 15).join("\n   ") || "(none)"));

    out.push("\n-- headings --");
    for (const heading of document.querySelectorAll("h1, h2")) {
      const text = (heading.textContent ?? "").trim().slice(0, 50);
      if (text && !/cookie|privacy/i.test(text)) out.push("   " + text);
    }
    return out.join("\n");
  }).catch((error) => "   probe failed: " + (error instanceof Error ? error.message.split("\n")[0] : String(error))));
}

console.log("\nBrowser stays open 45s.");
await page.waitForTimeout(45_000);
await context.close();
