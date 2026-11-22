// Exercises the REAL badge-proof code against your own signed-in Chrome, and
// shows exactly what would be sent to Telegram.
//
//   npm run test:proof
//
// Sends nothing. It prints the message text and writes the screenshot to
// streak-proof.png so the picture can be judged before it starts arriving on
// a phone every day.

import { chromium } from "playwright-core";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { captureStreakProof } from "../src/profile.ts";
import { describeRun } from "../src/report.ts";

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((candidate) => existsSync(candidate));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

// A real phone screen is narrow; a 1400px-wide shot of a badge grid is still
// readable, a 2560px one is not.
const context = await chromium.launchPersistentContext(resolve("local-browser-profile"), {
  executablePath: CHROME, headless: false, viewport: { width: 1400, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);

// Waits for the sign-in by WATCHING the page, rather than asking for a
// keypress. The keypress version blocks on stdin, which cannot be answered
// by anything driving this script from outside the terminal - so the run
// simply sat there. Polling costs nothing and removes the dance entirely.
// Signed in is tested by whether the badge page LOADS, not by looking for a
// Sign in button. Requesting /profile while signed out redirects to "/", and
// on a half-rendered page the button check reported a false "signed in".
const onBadgesPage = async () => {
  await page.goto("https://builder.aws.com/profile?tab=badges", { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.waitForTimeout(3500);
  return /\/profile/.test(page.url());
};

if (!(await onBadgesPage())) {
  console.log("=".repeat(68));
  console.log("  Signed OUT (the badge page redirected to the home page).");
  console.log("  Sign in to Builder Center in the Chrome window that just opened.");
  console.log("  This continues on its own once you are in.");
  console.log("=".repeat(68));

  const deadline = Date.now() + 240_000;
  let ok = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    if (await onBadgesPage()) { ok = true; break; }
  }
  if (!ok) {
    console.error("\nStill signed out after four minutes - stopping.");
    await context.close();
    process.exit(1);
  }
  console.log("\n  signed in - continuing");
}

const proof = await captureStreakProof(page, (line) => console.log("  · " + line));

console.log("\npage: " + proof.url);
console.log("signed in: " + proof.signedIn);
console.log("\n--- badges it read ---");
console.log(proof.badges.length > 0
  ? proof.badges.map((badge) => `   ${badge.state.padEnd(12)} ${badge.name}`).join("\n")
  : "   (none)");

if (proof.screenshot) {
  const file = resolve("streak-proof.png");
  writeFileSync(file, proof.screenshot);
  console.log(`\nscreenshot: ${file}  (${Math.round(proof.screenshot.length / 1024)} KB)`);
} else {
  console.log("\nNo screenshot captured.");
}

console.log("\n--- the Telegram message ---");
console.log(describeRun({
  utcDate: new Date().toISOString().slice(0, 10),
  liked: 1,
  likedTitles: ["Example article that was liked today"],
  commented: 1,
  commentedTitles: ["Example article that was commented on"],
  skippedAlreadyLiked: 4,
  articleSource: "search:5 keyword(s)",
  badges: proof.badges,
  proof: proof.screenshot,
}));

await context.close();
