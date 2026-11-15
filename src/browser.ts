import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { config } from "./config.js";
import { decryptBrowserState, encryptBrowserState, type BrowserState } from "./crypto.js";
import { loadBrowserState, saveBrowserState, type Candidate } from "./db.js";

const BUILDER_ORIGIN = "https://builder.aws.com";

export class BuilderBrowser {
  private constructor(private readonly browser: Browser, private readonly context: BrowserContext, private readonly page: Page) {}

  static async connect(): Promise<BuilderBrowser> {
    const endpoint = `wss://api.cloudflare.com/client/v4/accounts/${config.cfAccountId}/browser-run/devtools/browser?keep_alive=60000`;
    const browser = await chromium.connectOverCDP(endpoint, { headers: { Authorization: `Bearer ${config.cfApiToken}` } });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Cloudflare Browser Run did not provide a browser context");
    const saved = await loadBrowserState();
    if (!saved) {
      await browser.close();
      throw new Error("No encrypted AWS session is stored. Complete the one-time Live View setup first.");
    }
    const state = decryptBrowserState(saved);
    await context.addCookies(state.cookies);
    const page = context.pages()[0] ?? await context.newPage();
    await restoreLocalStorage(page, state);
    await page.goto(`${BUILDER_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    if (/sign-in|login/i.test(page.url())) throw new Error("AWS Builder ID session has expired; complete the Live View setup again");
    return new BuilderBrowser(browser, context, page);
  }

  static async captureFromExistingSession(sessionId: string): Promise<void> {
    const endpoint = `wss://api.cloudflare.com/client/v4/accounts/${config.cfAccountId}/browser-run/devtools/browser/${sessionId}`;
    const browser = await chromium.connectOverCDP(endpoint, { headers: { Authorization: `Bearer ${config.cfApiToken}` } });
    try {
      const context = browser.contexts()[0];
      const page = context?.pages().find((item) => item.url().startsWith(BUILDER_ORIGIN));
      if (!context || !page || /sign-in|login/i.test(page.url())) throw new Error("The Live View session is not signed in to AWS Builder Center");
      const localStorage = await page.evaluate(() => Object.entries(window.localStorage).map(([name, value]) => ({ name, value })));
      const state: BrowserState = { cookies: await context.cookies(), origins: [{ origin: BUILDER_ORIGIN, localStorage }] };
      await saveBrowserState(encryptBrowserState(state));
    } finally {
      await browser.close();
    }
  }

  async findArticles(limit: number): Promise<Candidate[]> {
    const links = await this.page.locator('a[href*="/content/"]').evaluateAll((nodes) => nodes.map((node) => ({ url: (node as HTMLAnchorElement).href, title: (node.textContent ?? "").trim() })).filter((item) => item.url && item.title));
    return [...new Map(links.map((item) => [item.url, item])).values()].slice(0, limit);
  }

  async readArticle(candidate: Candidate): Promise<string> {
    await this.page.goto(candidate.url, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(1000);
    return (await this.page.locator("main").innerText().catch(() => this.page.locator("body").innerText())).slice(0, 18000);
  }

  async likeCurrentArticle(): Promise<void> {
    const button = this.page.getByRole("button", { name: /like|react/i }).first();
    if (!(await button.isVisible().catch(() => false))) return;
    const label = (await button.getAttribute("aria-label"))?.toLowerCase() ?? "";
    const pressed = await button.getAttribute("aria-pressed");
    if (pressed !== "true" && !label.includes("unlike")) await button.click();
  }

  async postComment(comment: string): Promise<string | null> {
    const existing = this.page.getByText(comment, { exact: true }).first();
    if (await existing.isVisible().catch(() => false)) return "already-present";
    const input = this.page.locator("textarea").first();
    await input.waitFor({ state: "visible", timeout: 8000 });
    await input.fill(comment);
    const submit = this.page.getByRole("button", { name: /comment|post|reply/i }).last();
    await submit.click();
    await this.page.getByText(comment, { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
    return "verified-in-page";
  }

  async close(): Promise<void> { await this.browser.close(); }
}

async function restoreLocalStorage(page: Page, state: BrowserState): Promise<void> {
  const builder = state.origins.find((item) => item.origin === BUILDER_ORIGIN);
  if (!builder) return;
  await page.goto(BUILDER_ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate((items) => { window.localStorage.clear(); for (const item of items) window.localStorage.setItem(item.name, item.value); }, builder.localStorage);
}
