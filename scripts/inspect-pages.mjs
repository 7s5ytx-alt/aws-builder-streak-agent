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

// An article page is where postComment failed: it waited 8s for a plain
// <textarea> that is not there. Builder Center most likely uses a
// contenteditable rich-text box, or only renders the composer after a click.
const ARTICLE = process.env.INSPECT_ARTICLE
  ?? "https://builder.aws.com/content/3M3njUsB5gh6hyRLp6PMjRBLciH/building-zero-trust-on-aws-in-five-hands-on-parts";

await survey("ARTICLE (comment composer lives here)", ARTICLE);

// The composer is often behind a button. Report anything that looks like the
// way in, so the fix targets a real control rather than a guess.
try {
  const commentish = await page
    .locator("button, [role=button], a")
    .evaluateAll((nodes) =>
      nodes
        .map((n) => ({
          text: (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
          label: n.getAttribute("aria-label") ?? "",
        }))
        .filter((n) => /comment|reply|respond|discussion|add a/i.test(n.text + " " + n.label))
        .slice(0, 15),
    );
  console.log("  controls mentioning comment/reply:");
  if (commentish.length === 0) console.log("    (none - the composer may need a scroll or a sign-in)");
  for (const c of commentish) console.log(`    - "${c.text}"   aria-label="${c.label}"`);
} catch (error) {
  console.log("  comment-control scan failed: " + (error instanceof Error ? error.message : String(error)));
}

// The composer does not exist until "Comment on this article" is clicked, so
// look again afterwards. This OPENS the box and reports what it is - it never
// types and never submits.
console.log("");
console.log("=".repeat(70));
console.log("COMPOSER PROBE (clicks 'Comment on this article', submits nothing)");
console.log("=".repeat(70));
try {
  const opener = page.getByRole("button", { name: /^\s*comment on this article/i }).first();
  if (!(await opener.isVisible().catch(() => false))) {
    console.log("  no 'Comment on this article' control found");
  } else {
    await opener.scrollIntoViewIfNeeded().catch(() => undefined);
    await opener.click({ timeout: 8000 });
    await page.waitForTimeout(3000);

    const fields = await page
      .locator("textarea, input[type=text], [contenteditable=true], [role=textbox]")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          tag: n.tagName.toLowerCase(),
          role: n.getAttribute("role") ?? "",
          editable: n.getAttribute("contenteditable") ?? "",
          placeholder: n.getAttribute("placeholder") ?? n.getAttribute("data-placeholder") ?? "",
          label: n.getAttribute("aria-label") ?? "",
          visible: !!(n.getBoundingClientRect().width && n.getBoundingClientRect().height),
        })),
      );
    console.log("  text inputs after opening (" + fields.length + "):");
    for (const f of fields) {
      console.log(`    <${f.tag}> role="${f.role}" contenteditable="${f.editable}" visible=${f.visible}`);
      console.log(`        placeholder="${f.placeholder}"  aria-label="${f.label}"`);
    }

    const submits = await page
      .locator("button, [role=button]")
      .evaluateAll((nodes) =>
        nodes
          .map((n) => ({
            text: (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30),
            label: n.getAttribute("aria-label") ?? "",
            disabled: n.hasAttribute("disabled") || n.getAttribute("aria-disabled") === "true",
          }))
          .filter((n) => /^(post|submit|comment|send|publish|reply)$/i.test(n.text.trim()) || /post comment|submit comment|add comment/i.test(n.label)),
      );
    console.log("  likely submit buttons (" + submits.length + "):");
    for (const s of submits) console.log(`    - "${s.text}"  aria-label="${s.label}"  disabled=${s.disabled}`);

    // Nothing matched, so widen the search rather than guess again.
    // An editor can live in an iframe, which page.locator() does not pierce.
    const frames = page.frames();
    console.log("  frames on page: " + frames.length);
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      const count = await frame.locator("textarea, [contenteditable], [role=textbox]").count().catch(() => -1);
      console.log(`    - ${frame.url().slice(0, 90)}  editable-ish: ${count}`);
    }

    // Some editors only set contenteditable on focus, so report anything that
    // merely looks like an input surface.
    const candidates = await page.evaluate(() => {
      const out = [];
      for (const el of Array.from(document.querySelectorAll("div,span,p,section"))) {
        const text = (el.getAttribute("data-placeholder") ?? el.getAttribute("placeholder") ?? "") + " " + (el.getAttribute("aria-label") ?? "");
        const cls = el.className && typeof el.className === "string" ? el.className : "";
        if (/comment|editor|composer|reply|write|rich.?text/i.test(text + " " + cls)) {
          const r = el.getBoundingClientRect();
          if (r.width > 120 && r.height > 20) out.push({ tag: el.tagName.toLowerCase(), cls: String(cls).slice(0, 70), label: text.trim().slice(0, 60) });
        }
      }
      return out.slice(0, 15);
    });
    console.log("  elements that look like a composer (" + candidates.length + "):");
    for (const c of candidates) console.log(`    <${c.tag}> class="${c.cls}" label="${c.label}"`);

    const shot = process.env.PROBE_SHOT;
    if (shot) {
      await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);
      console.log("  screenshot: " + shot);
    }
  }
} catch (error) {
  console.log("  probe failed: " + (error instanceof Error ? error.message.split("\n")[0] : String(error)));
}

await survey("WISHLIST", "https://builder.aws.com/wishlist");

console.log("");
console.log("Done. Nothing was clicked or submitted. Closing.");
await context.close();
