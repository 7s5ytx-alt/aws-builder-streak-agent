// Diagnostic only. Opens one article's comment composer and reports what the
// editor actually is, where focus goes on click, and what each typing method
// does to the DOM. Written because `typing did not land` is a symptom with at
// least four plausible causes and guessing between them has cost days.
//
//   npm run probe:editor [articleUrl]

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const URL_ARG = process.argv[2]
  ?? "https://builder.aws.com/content/3M3qSo4KH3KNMJdJ6SExYVuylnA/aws-emulator-in-practice-test-aw";

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((c) => existsSync(c));
if (!CHROME) { console.error("Chrome not found."); process.exit(1); }

const context = await chromium.launchPersistentContext(resolve("local-browser-profile"), {
  executablePath: CHROME, headless: false, viewport: null, args: ["--start-maximized"],
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto(URL_ARG, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

const opener = page.getByRole("button", { name: /^\s*comment on this article/i }).first();
if (await opener.isVisible().catch(() => false)) {
  await opener.click({ timeout: 8000 });
  await page.waitForTimeout(3000);
  console.log("clicked opener\n");
}
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(1500);

const describe = (label: string) => page.evaluate((lbl) => {
  const sels = ['[data-slate-editor="true"]', ".slate-editor", '[role="textbox"][contenteditable="true"]', "textarea", "[contenteditable]"];
  const out: string[] = [`--- ${lbl} ---`];
  for (const sel of sels) {
    const nodes = [...document.querySelectorAll(sel)];
    out.push(`${sel}  ->  ${nodes.length} match(es)`);
    nodes.forEach((n, i) => {
      const r = n.getBoundingClientRect();
      out.push(`   [${i}] <${n.tagName.toLowerCase()}> ${Math.round(r.width)}x${Math.round(r.height)}`
        + ` ce=${(n as HTMLElement).isContentEditable}`
        + ` disabled=${n.hasAttribute("disabled")}`
        + ` ariaDisabled=${n.getAttribute("aria-disabled")}`
        + ` readonly=${n.hasAttribute("readonly")}`
        + ` text="${(n.textContent ?? "").slice(0, 60)}"`);
    });
  }
  const a = document.activeElement as HTMLElement | null;
  out.push(`activeElement: <${a?.tagName.toLowerCase()}> ce=${a?.isContentEditable} cls="${(a?.className ?? "").toString().slice(0, 70)}"`);
  return out.join("\n");
}, label);

console.log(await describe("after composer opened"));

const editor = page.locator('[data-slate-editor="true"], .slate-editor, [role="textbox"][contenteditable="true"], textarea').first();
await editor.click({ timeout: 5000 }).catch((e) => console.log("click failed: " + e.message.split("\n")[0]));
await page.waitForTimeout(600);
console.log("\n" + await describe("after clicking the editor"));

await page.keyboard.type("PROBE123", { delay: 40 });
await page.waitForTimeout(1200);
console.log("\n" + await describe("after keyboard.type"));

console.log("\n--- innerHTML of first match ---");
console.log(((await editor.innerHTML().catch(() => "<unreadable>")) ?? "").slice(0, 1200));

console.log("\n--- submit buttons ---");
console.log(await page.evaluate(() => [...document.querySelectorAll("button")]
  .filter((b) => /submit|post|comment/i.test(b.textContent ?? "") || /submit|post|comment/i.test(b.getAttribute("aria-label") ?? ""))
  .map((b) => `"${(b.textContent ?? "").trim().slice(0, 30)}" aria-label="${b.getAttribute("aria-label")}" disabled=${b.hasAttribute("disabled")} aria-disabled=${b.getAttribute("aria-disabled")}`)
  .join("\n")));

console.log("\nLeaving the browser open for 60s so you can look.");
await page.waitForTimeout(60_000);
await context.close();
