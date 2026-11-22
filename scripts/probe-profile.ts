// Diagnostic only. Finds the profile / badges page and reports what can be
// read from it, then saves a screenshot so the layout can be inspected.
//
//   npm run probe:profile
//
// Needed because the streak proof has to come from the page itself. Reading
// "what the agent did" out of our own database proves only what the agent
// attempted; the badge grid is what Builder Center actually credits.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((candidate) => existsSync(candidate));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

const context = await chromium.launchPersistentContext(resolve("local-browser-profile"), {
  executablePath: CHROME, headless: false, viewport: { width: 1400, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

// This profile's auth cookies are session cookies, discarded when Chrome
// closes, so it is usually signed out. The badge grid only exists for a
// signed-in user, so pause rather than probe a logged-out page.
if (await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false)) {
  console.log("=".repeat(68));
  console.log("  Signed OUT. Sign in to Builder Center in the Chrome window that");
  console.log("  just opened, then come back here and press Enter.");
  console.log("=".repeat(68));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("\n  Press Enter once signed in... ");
  rl.close();
  await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.waitForTimeout(3000);
}

// The profile link hides behind the avatar menu; find it rather than guess.
console.log("--- profile-ish links on the home page ---");
console.log(await page.evaluate(() =>
  [...new Set([...document.querySelectorAll("a[href]")]
    .map((a) => a.getAttribute("href") ?? "")
    .filter((href) => /profile|badge|\/u\/|\/@|achievement/i.test(href)))]
    .slice(0, 15).join("\n   ") || "   (none visible - trying the avatar menu)"));

const avatar = page.getByRole("button", { name: /anuku|profile|account/i }).first();
if (await avatar.isVisible().catch(() => false)) {
  await avatar.click({ timeout: 6000 }).catch(() => undefined);
  await page.waitForTimeout(1800);
  console.log("\n--- after opening the avatar menu ---");
  console.log(await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('a[href], [role="menuitem"]')]
      .filter((el) => el.getBoundingClientRect().height > 0)
      .map((el) => `${(el.textContent ?? "").trim().slice(0, 28)} -> ${el.getAttribute("href") ?? "-"}`))]
      .slice(0, 20).join("\n   ")));
}

// Try the likely paths and report which one actually renders a badge grid.
for (const path of ["/profile", "/me", "/settings/profile"]) {
  await page.goto("https://builder.aws.com" + path, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.waitForTimeout(4000);
  const found = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      notFound: /can't be found|not found/i.test(text),
      badgeWords: (text.match(/streak|badge/gi) ?? []).length,
      sample: text.replace(/\s+/g, " ").slice(0, 160),
    };
  }).catch(() => null);
  console.log(`\n${path} -> ${page.url()}`);
  console.log(`   notFound=${found?.notFound} badge/streak words=${found?.badgeWords}`);
  console.log(`   ${found?.sample ?? "(unreadable)"}`);
  if (found && !found.notFound && found.badgeWords > 0) {
    console.log("\n--- streak / badge lines on this page ---");
    console.log(await page.evaluate(() =>
      document.body.innerText.split("\n")
        .map((line) => line.trim())
        .filter((line) => /streak|badge|day|visit|like|comment/i.test(line) && line.length < 90)
        .slice(0, 30).map((line) => "   " + line).join("\n")));
    await page.screenshot({ path: resolve("profile-probe.png"), fullPage: false });
    console.log(`\nscreenshot: ${resolve("profile-probe.png")}`);
    break;
  }
}

await page.waitForTimeout(20_000);
await context.close();
