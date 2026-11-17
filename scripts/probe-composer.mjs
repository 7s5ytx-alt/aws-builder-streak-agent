// Finds an article that actually accepts comments and reports what its
// composer is made of.
//
//   npm run probe
//
// Why: the first article the agent picked showed "Comments aren't available on
// this article", so there was no composer to find and postComment timed out
// waiting for a <textarea>. That is an article-selection problem, not a
// selector problem - but the real composer still has to be identified before
// posting can work anywhere.
//
// It OPENS composers and reports them. It types nothing and submits nothing.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PROFILE_DIR = resolve("local-browser-profile");
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => existsSync(p));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

const SHOT = process.env.PROBE_SHOT;
const MAX_ARTICLES = Number(process.env.PROBE_MAX ?? 6);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: CHROME, headless: false, viewport: null, args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(4000);

const articles = await page
  .locator('a[href*="/content/"]')
  .evaluateAll((nodes) => {
    const seen = new Set();
    const out = [];
    for (const n of nodes) {
      const href = n.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push({ url: href, title: (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60) });
    }
    return out;
  })
  .catch(() => []);

console.log(`Found ${articles.length} article links. Probing up to ${MAX_ARTICLES}.`);

let found = false;

for (const article of articles.slice(0, MAX_ARTICLES)) {
  console.log("");
  console.log("-".repeat(68));
  console.log(article.title || "(untitled)");
  console.log(article.url.slice(0, 100));

  try {
    await page.goto(article.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    const opener = page.getByRole("button", { name: /^\s*comment on this article/i }).first();
    if (!(await opener.isVisible().catch(() => false))) {
      console.log("  no comment control at all");
      continue;
    }
    await opener.scrollIntoViewIfNeeded().catch(() => undefined);
    await opener.click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(3000);

    // The banner is the clean signal that this article will never accept one.
    const disabled = await page
      .getByText(/comments aren.?t available on this article/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (disabled) {
      console.log("  COMMENTS DISABLED on this article");
      continue;
    }

    const fields = await page
      .locator("textarea, [contenteditable=true], [role=textbox]")
      .evaluateAll((nodes) =>
        nodes
          .map((n) => {
            const r = n.getBoundingClientRect();
            return {
              tag: n.tagName.toLowerCase(),
              role: n.getAttribute("role") ?? "",
              editable: n.getAttribute("contenteditable") ?? "",
              placeholder: n.getAttribute("placeholder") ?? n.getAttribute("data-placeholder") ?? "",
              label: n.getAttribute("aria-label") ?? "",
              visible: r.width > 50 && r.height > 15,
            };
          })
          .filter((f) => f.visible),
      );

    console.log(`  COMPOSER PRESENT - ${fields.length} input(s):`);
    for (const f of fields) {
      console.log(`    <${f.tag}> role="${f.role}" contenteditable="${f.editable}"`);
      console.log(`        placeholder="${f.placeholder}"  aria-label="${f.label}"`);
    }

    const submits = await page
      .locator("button, [role=button]")
      .evaluateAll((nodes) =>
        nodes
          .map((n) => ({
            text: (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 24),
            label: n.getAttribute("aria-label") ?? "",
            disabled: n.hasAttribute("disabled") || n.getAttribute("aria-disabled") === "true",
          }))
          .filter((n) => /^(post|submit|comment|send|publish|reply|add comment)$/i.test(n.text) || /post|submit/i.test(n.label)),
      );
    console.log(`  submit candidates (${submits.length}):`);
    for (const s of submits) console.log(`    - "${s.text}"  aria-label="${s.label}"  disabled=${s.disabled}`);

    if (fields.length > 0) {
      found = true;
      if (SHOT) {
        await page.screenshot({ path: SHOT }).catch(() => undefined);
        console.log("  screenshot: " + SHOT);
      }
      console.log("");
      console.log("  ^^ This is the article to model the selector on.");
      break;
    }
  } catch (error) {
    console.log("  probe error: " + (error instanceof Error ? error.message.split("\n")[0] : String(error)));
  }
}

console.log("");
console.log(found
  ? "Found a usable composer. Nothing was typed or submitted."
  : "No article with an open composer in the sample. Comments may be disabled broadly, or the composer needs a different trigger.");

await context.close();
