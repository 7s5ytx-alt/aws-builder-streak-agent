import { chromium, type Browser, type Page } from "playwright-core";
import { config } from "./config.js";
import type { Candidate } from "./db.js";

export class BuilderBrowser {
  private constructor(private readonly browser: Browser, private readonly page: Page) {}

  static async connect(): Promise<BuilderBrowser> {
    const browser = await chromium.connectOverCDP(config.browserWsEndpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Cloud browser has no persistent context");
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" });
    if (/sign-in|login/i.test(page.url())) throw new Error("AWS Builder ID session has expired; sign in again in the cloud browser");
    return new BuilderBrowser(browser, page);
  }

  async findArticles(limit: number): Promise<Candidate[]> {
    const links = await this.page.locator('a[href*="/content/"]').evaluateAll((nodes) => nodes.map((node) => ({
      url: (node as HTMLAnchorElement).href,
      title: (node.textContent ?? "").trim(),
    })).filter((item) => item.url && item.title));
    return [...new Map(links.map((item) => [item.url, item])).values()].slice(0, limit);
  }

  async readArticle(candidate: Candidate): Promise<string> {
    await this.page.goto(candidate.url, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(1500);
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

  // The browser is a persistent remote profile. Vercel closes this function's
  // websocket when the invocation ends; closing the remote browser could lose
  // its authenticated session.
  async close(): Promise<void> { void this.browser; }
}
