// Signs you in to AWS Builder Center in YOUR OWN Chrome, then sends the
// resulting signed-in state to the deployed app, which encrypts it into Neon.
//
//   npm run capture:local
//
// Why this exists: an AWS Builder ID federated through Google SSO cannot
// complete its sign-in inside Cloudflare Browser Run - Google's password
// challenge returns a 500 to that browser. A normal local Chrome has no such
// problem. The scheduled cloud run never signs in; it only replays the state
// captured here, so it never meets a login page at all.
//
// Nothing secret is printed. Cookie and localStorage KEY NAMES are shown so
// you can see what is being sent; values never are.

import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const ENDPOINT =
  process.env.IMPORT_ENDPOINT ??
  "https://aws-builder-streak-agent.vercel.app/api/session?action=import";

const BUILDER_ORIGIN = "https://builder.aws.com";
const BUILDER_HOME = BUILDER_ORIGIN + "/";
const PROFILE_DIR = resolve("local-browser-profile");

// Analytics, consent and RUM cookies are present on aws.com whether or not
// anyone is signed in. Counting them as proof of a session was the bug in the
// first version of this script: it "detected" a login six seconds after Chrome
// opened. Anything matching these is evidence of nothing.
const NOISE_COOKIE = /^(cwr_|awsccc|AMCVS?_|s_cc|s_sq|s_vi|_ga|_gid|regStatus|aws-ubid|aws-target|aws-x-)/i;

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe" : null,
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error("Could not find Chrome. Looked in:");
  for (const candidate of CHROME_CANDIDATES) console.error("  " + candidate);
  process.exit(1);
}

let setupSecret;
try {
  setupSecret = readFileSync(resolve(".setup-session-token"), "utf8").trim();
} catch {
  console.error("Could not read .setup-session-token in the project root.");
  process.exit(1);
}
if (!setupSecret) {
  console.error(".setup-session-token is empty.");
  process.exit(1);
}

// AWS plus the identity provider. The Google cookies are needed because
// Builder Center refreshes its short-lived tokens through SSO in the
// background; without them the replayed session goes anonymous within the
// hour and every like is silently ignored. An allowlist, not "everything in
// the profile", so unrelated sites stay out of the blob.
const CAPTURED_DOMAIN_SUFFIXES = [
  "aws.com", "amazon.com", "amazonaws.com", "aws",
  "google.com", "googleapis.com", "googleusercontent.com", "accounts.google.com",
];

function isCapturedDomain(domain) {
  const host = String(domain).toLowerCase().replace(/^\./, "");
  return CAPTURED_DOMAIN_SUFFIXES.some((suffix) => host === suffix || host.endsWith("." + suffix));
}

console.log("Opening your Chrome. Profile: " + PROFILE_DIR);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: chromePath,
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BUILDER_HOME, { waitUntil: "domcontentloaded" }).catch(() => {});

console.log("");
console.log("=".repeat(66));
console.log("  SIGN IN TO AWS BUILDER CENTER IN THE CHROME WINDOW.");
console.log("  Use Google if that is how your Builder ID works. It will work");
console.log("  here - this is your real browser, not a remote one.");
console.log("");
console.log("  When you can see you are signed in (your avatar or profile menu");
console.log("  in the top right), come back here and press Enter.");
console.log("=".repeat(66));
console.log("");

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("  Press Enter once you are signed in... ");
rl.close();
console.log("");

// Evidence, not assumption. A visible "Sign in" control means the page still
// considers this browser anonymous, whatever cookies happen to be set.
const signedOutMarker =
  (await page.getByRole("link", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false)) ||
  (await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false));

const currentUrl = page.url();
const allCookies = await context.cookies();
const awsCookies = allCookies.filter((cookie) => isCapturedDomain(cookie.domain));
const meaningful = awsCookies.filter((cookie) => !NOISE_COOKIE.test(cookie.name));
const providerCount = awsCookies.filter((cookie) => /google/i.test(cookie.domain)).length;

const localStorageItems = await page
  .evaluate(() => Object.entries(window.localStorage).map(([name, value]) => ({ name, value })))
  .catch(() => []);

console.log("  page url            : " + currentUrl);
console.log("  sign-in button shown: " + (signedOutMarker ? "YES - looks signed OUT" : "no"));
console.log("  cookies captured    : " + awsCookies.length + " (" + meaningful.length + " beyond analytics, " + providerCount + " from the sign-in provider)");
console.log("  non-analytics names : " + (meaningful.map((c) => c.name).join(", ") || "(none)"));
console.log("  localStorage keys   : " + (localStorageItems.map((i) => i.name).join(", ") || "(none)"));
console.log("");

const problems = [];
if (signedOutMarker) problems.push("the page still shows a Sign in control");
if (!currentUrl.startsWith(BUILDER_ORIGIN)) problems.push("the page is not on builder.aws.com");
if (meaningful.length === 0 && localStorageItems.length === 0) problems.push("no session cookie or localStorage token found");

if (problems.length > 0) {
  console.error("NOT SENDING. This does not look signed in:");
  for (const problem of problems) console.error("  - " + problem);
  console.error("");
  console.error("Sign in fully, then run npm run capture:local again.");
  await context.close();
  process.exit(1);
}

const captured = {
  cookies: awsCookies,
  origins: [{ origin: BUILDER_ORIGIN, localStorage: localStorageItems }],
};

console.log("Sending to " + ENDPOINT.split("?")[0] + " ...");

const response = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + setupSecret },
  body: JSON.stringify(captured),
});

const text = await response.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { raw: text.slice(0, 300) };
}

if (!response.ok || body.ok === false) {
  console.error("");
  console.error("IMPORT FAILED (HTTP " + response.status + ")");
  console.error(JSON.stringify(body, null, 2).slice(0, 600));
  await context.close();
  process.exit(1);
}

console.log("");
console.log("DONE. " + (body.message ?? "State saved") + " (" + body.cookies + " cookies).");
console.log("The scheduled run will replay this state. You can close Chrome.");

await context.close();
