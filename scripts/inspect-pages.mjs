// Read-only reconnaissance of the Builder Center pages the agent does not yet
// know how to drive: the Wishlist and the discussion composer.
//
//   npm run inspect
//
// It opens the signed-in local Chrome profile, visits each page and prints the
// interactive elements it finds, so selectors can be written against the real
// DOM instead of guessed. It CLICKS NOTHING and submits nothing - the point is
// to look before automating anything that would post publicly.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PROFILE_DIR = resolve("local-browser-profile");
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe" : null,
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) { console.error("Chrome not found."); process.exit(1); }

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: chromePath,
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});

const page = context.pages()[0] ?? (await context.newPage());

async function survey(label, url) {
  console.log("");
  console.log("=".repeat(70));
  console.log(label + "   " + url);
  console.log("=".repeat(70));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(4_000);
  } catch (error) {
    console.log("  could not load: " + (error instanceof Error ? error.message : String(error)));
    return;
  }

  console.log("  final url : " + page.url());
  console.log("  title     : " + (await page.title().catch(() => "?")));

  const buttons = await page
    .locator("button, [role=button]")
    .evaluateAll((nodes) =>
      nodes
        .map((n) => ({
          text: (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 48),
          label: n.getAttribute("aria-label") ?? "",
          pressed: n.getAttribute("aria-pressed") ?? "",
          testid: n.getAttribute("data-testid") ?? "",
        }))
        .filter((b) => b.text || b.label)
        .slice(0, 40),
    )
    .catch(() => []);

  console.log("  buttons (" + buttons.length + "):");
  for (const b of buttons) {
    const extra = [b.label && `aria-label="${b.label}"`, b.pressed && `aria-pressed=${b.pressed}`, b.testid && `testid=${b.testid}`]
      .filter(Boolean)
      .join("  ");
    console.log("    - " + (b.text || "(no text)").padEnd(50) + extra);
  }

  const links = await page
    .locator("a[href]")
    .evaluateAll((nodes) => {
      const seen = new Set();
      const out = [];
      for (const n of nodes) {
        const href = n.href;
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const text = (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 44);
        if (!text) continue;
        out.push({ text, href });
      }
      return out.slice(0, 15);
    })
    .catch(() => []);

  console.log("  first links:");
  for (const l of links) console.log("    - " + l.text.padEnd(46) + l.href.slice(0, 80));

  const fields = await page
    .locator("textarea, input[type=text], [contenteditable=true]")
    .evaluateAll((nodes) =>
      nodes.map((n) => ({
        tag: n.tagName.toLowerCase(),
        placeholder: n.getAttribute("placeholder") ?? "",
        label: n.getAttribute("aria-label") ?? "",
      })).slice(0, 10),
    )
    .catch(() => []);
  console.log("  text fields (" + fields.length + "):");
  for (const f of fields) console.log(`    - <${f.tag}> placeholder="${f.placeholder}" aria-label="${f.label}"`);
}

await survey("WISHLIST", "https://builder.aws.com/wishlist");
await survey("HOME (for the + / create menu)", "https://builder.aws.com/");

console.log("");
console.log("Done. Nothing was clicked or submitted. Closing.");
await context.close();
