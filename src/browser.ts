import { postCommentOnPage } from "./comment.js";
import { likeInFeedOnPage, searchManyOnPage, type SearchResult } from "./feed.js";
import { findWishesOnPage, voteOnWishOnPage, type Wish } from "./wishlist.js";
import { createArticle, createPost, createWish } from "./create.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { config } from "./config.js";
import { decryptBrowserState, encryptBrowserState, type BrowserState } from "./crypto.js";
import { loadBrowserState, saveBrowserState, type Candidate } from "./db.js";

const BUILDER_ORIGIN = "https://builder.aws.com";

// How long Cloudflare keeps the remote browser alive. Must exceed the run
// deadline in api/daily.ts (200s) so the browser cannot vanish mid-run.
const BROWSER_KEEP_ALIVE_MS = 240_000;

// AWS plus the identity provider. Google's cookies are needed because Builder
// Center refreshes its short-lived tokens through SSO; without them the
// replayed session is anonymous within hours. Exported so the import endpoint
// applies exactly the same rule - two copies drifting apart is how the first
// version of this filter silently broke every like.
export const CAPTURED_DOMAIN_SUFFIXES = [
  "aws.com", "amazon.com", "amazonaws.com", "aws",
  "google.com", "googleapis.com", "googleusercontent.com", "accounts.google.com",
];

export function isCapturedDomain(domain: string): boolean {
  const host = domain.toLowerCase().replace(/^\./, "");
  return CAPTURED_DOMAIN_SUFFIXES.some((suffix) => host === suffix || host.endsWith("." + suffix));
}

export class BuilderBrowser {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    readonly accountUsed: string,
  ) {}

  static async connect(): Promise<BuilderBrowser> {
    // Read the stored session BEFORE opening a browser. The old order opened
    // one first and only then discovered there was nothing to restore, which
    // spent Browser Run minutes to learn something the database already knew.
    const saved = await loadBrowserState();
    if (!saved) throw new Error("No encrypted AWS session is stored. Run `npm run capture:local` first.");
    const state = decryptBrowserState(saved);

    // Each account has its own daily allowance, so an exhausted one answers
    // 429 at the handshake and costs nothing. Trying the next is free.
    const failures: string[] = [];
    for (const account of config.cfAccounts) {
      // keep_alive must outlast the whole run, not one step.
      //
      // It was 60s, which fitted the old flow: open the home feed, like on
      // the article page, done. The search flow is longer - two keyword
      // queries, likes taken in the results, then an article load and an AI
      // call - and on 2026-11-18 the browser was torn down mid-run with
      // "Target page, context or browser has been closed" AFTER the like
      // landed but BEFORE the comment, losing that day's comment streak.
      //
      // 240s sits comfortably above api/daily.ts's 200s deadline and below
      // Vercel's 300s maxDuration. A longer window costs nothing against the
      // ten free minutes a day: the allowance is spent on time the browser is
      // actually alive, and close() runs in a finally block.
      const endpoint = `wss://api.cloudflare.com/client/v4/accounts/${account.accountId}/browser-run/devtools/browser?keep_alive=${BROWSER_KEEP_ALIVE_MS}`;
      let browser: Browser;
      try {
        browser = await chromium.connectOverCDP(endpoint, { headers: { Authorization: `Bearer ${account.apiToken}` } });
      } catch (error) {
        failures.push(`${account.label}: ${firstLine(error)}`);
        continue;
      }

      // Past the handshake the browser is real and already costing minutes.
      // Anything failing from here is a genuine fault - an expired AWS session,
      // a changed page - and the next account would fail identically, so close
      // this one and surface the error rather than burning another allowance.
      try {
        const context = browser.contexts()[0];
        if (!context) throw new Error("Cloudflare Browser Run did not provide a browser context");
        await context.addCookies(state.cookies);
        const page = context.pages()[0] ?? await context.newPage();
        await restoreLocalStorage(page, state);
        await page.goto(`${BUILDER_ORIGIN}/`, { waitUntil: "domcontentloaded" });

        // The URL check alone was not enough. Builder Center serves articles
        // to anyone, so a signed-OUT visitor lands on a perfectly ordinary
        // builder.aws.com/ URL and the run proceeded believing it was logged
        // in - reading and liking happily, with every like silently ignored
        // because that action needs auth. Ask the page instead.
        await page.waitForTimeout(2000);
        const signedOut =
          (await page.getByRole("link", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false)) ||
          (await page.getByRole("button", { name: /^\s*sign in\s*$/i }).first().isVisible().catch(() => false));
        if (signedOut || /sign-in|login/i.test(page.url())) {
          throw new Error("AWS Builder ID session has expired (the page still offers Sign in); run `npm run capture:local` again");
        }
        return new BuilderBrowser(browser, context, page, account.label);
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
      }
    }

    throw new Error(`No Cloudflare account could start a browser (tried ${config.cfAccounts.length}). ${failures.join(" | ")}`);
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

  // Busiest articles first.
  //
  // Many Builder Center articles have comments closed, and the agent spent
  // days drafting comments it could never post. The feed shows each article's
  // comment count ("Comments 91"), and while a count is not a guarantee - one
  // closed article still showed 1 - an article with dozens of comments is
  // overwhelmingly more likely to still accept them than one with none.
  async findArticlesByActivity(limit: number): Promise<Candidate[]> {
    const links = await this.page
      .locator('a[href*="/content/"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const anchor = node as HTMLAnchorElement;
          // Walk up to the card that holds both the link and its counts.
          let container: HTMLElement | null = anchor;
          let comments = 0;
          for (let depth = 0; depth < 8 && container; depth += 1) {
            const button = container.querySelector('[aria-label^="Comments "], [aria-label^="Comment on this article"]');
            const label = button?.getAttribute("aria-label") ?? "";
            const found = /(\d+)\s*$/.exec(label);
            if (found) { comments = Number(found[1]); break; }
            container = container.parentElement;
          }
          return { url: anchor.href, title: (anchor.textContent ?? "").trim(), comments };
        }).filter((item) => item.url && item.title),
      )
      .catch(() => [] as Array<{ url: string; title: string; comments: number }>);

    const unique = [...new Map(links.map((item) => [item.url, item])).values()];
    unique.sort((a, b) => b.comments - a.comments);
    return unique.slice(0, limit).map(({ url, title }) => ({ url, title }));
  }
  // Articles from Builder Center's own search, which beats the home feed on
  // both counts that matter: the home page is a carousel of a couple of dozen
  // promoted posts, while search returns the busy community ones, and each
  // result card carries its comment count as a link.
  //
  // Delegates to src/feed.ts so `npm run test:search` drives the exact code
  // that runs at 6am against a local Chrome, for free.
  // onPanel runs while one query's results are still on screen, which is the
  // only moment its like buttons can be clicked.
  async searchArticles(
    queries: string[],
    limit: number,
    onPanel?: (results: SearchResult[]) => Promise<void>,
  ): Promise<SearchResult[]> {
    return searchManyOnPage(this.page, queries, limit, () => undefined, onPanel);
  }

  // Likes an article straight from the results list, without opening it.
  async likeInFeed(articleUrl: string): Promise<string> {
    return likeInFeedOnPage(this.page, articleUrl);
  }

  // --- Creating content ---------------------------------------------------

  async publishArticle(article: { title: string; description: string; body: string; tag?: string }): Promise<string> {
    return createArticle(this.page, article, { submit: true });
  }

  async publishWish(wish: { title: string; description: string; category?: string }): Promise<string> {
    return createWish(this.page, wish, { submit: true });
  }

  async publishPost(post: { title: string; body: string }): Promise<string> {
    return createPost(this.page, post, { submit: true });
  }

  // --- Wishlist (4-week wish vote streak badge) ---------------------------

  async openWishlist(): Promise<void> {
    await this.page.goto(`${BUILDER_ORIGIN}/wishlist`, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(4000);
    await this.dismissConsentBanner();
  }

  async findWishes(limit: number): Promise<Wish[]> {
    return findWishesOnPage(this.page, limit);
  }

  async voteOnWish(wishUrl: string): Promise<string> {
    return voteOnWishOnPage(this.page, wishUrl);
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

  // Returns what actually happened, because the previous version could not
  // tell "liked it" from "never found the button" - both ended as a silent
  // return, and the run still reported success. A streak agent that cannot
  // confirm its one essential action is not reporting anything useful.
  async likeCurrentArticle(): Promise<string> {
    // Builder Center labels the control "Like article, <title> <count>", so
    // anchor on that and only fall back to the loose match. The old
    // /like|react/i with .first() could match a sidebar or related-article
    // control before the article's own button.
    const precise = this.page.getByRole("button", { name: /^\s*like article/i }).first();
    const loose = this.page.getByRole("button", { name: /like|react/i }).first();
    const button = (await precise.isVisible().catch(() => false)) ? precise : loose;
    if (!(await button.isVisible().catch(() => false))) return "not-found";

    const label = (await button.getAttribute("aria-label"))?.toLowerCase() ?? "";
    if ((await button.getAttribute("aria-pressed")) === "true" || label.includes("unlike")) return "already-liked";

    // A cookie banner renders above the content on a fresh browser, and the
    // cloud browser is always fresh. Playwright's click would then time out
    // on an intercepted element - previously swallowed, which is how this
    // looked like a click that simply did nothing.
    await this.dismissConsentBanner();
    await button.scrollIntoViewIfNeeded().catch(() => undefined);

    let clickError = "";
    try {
      await button.click({ timeout: 8000 });
    } catch (error) {
      clickError = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 120);
    }

    // Verify rather than assume. aria-pressed flipping is the page telling us
    // the like registered; without it this function is back to guessing.
    await this.page.waitForTimeout(1500);
    const after = await button.getAttribute("aria-pressed").catch(() => null);
    const afterLabel = (await button.getAttribute("aria-label").catch(() => ""))?.toLowerCase() ?? "";
    if (after === "true" || afterLabel.includes("unlike")) return "liked";

    if (clickError) return `click-error: ${clickError}`;
    return `no-change (label="${label.slice(0, 60)}", pressed=${after})`;
  }

  // Best effort: the banner is not always present, and never blocking enough
  // to fail a run over.
  private async dismissConsentBanner(): Promise<void> {
    for (const name of [/accept all cookies/i, /^\s*accept\s*$/i]) {
      const accept = this.page.getByRole("button", { name }).first();
      if (await accept.isVisible().catch(() => false)) {
        await accept.click({ timeout: 3000 }).catch(() => undefined);
        await this.page.waitForTimeout(500);
        return;
      }
    }
  }

  // Delegates to src/comment.ts so the steps that run in production are the
  // exact ones `npm run test:comment` exercises against a local Chrome. A
  // second copy would drift, and every bug found in this path so far lived in
  // a detail: the Slate editor, its placeholder, the disabled Submit button.
  async postComment(comment: string, articleUrl?: string): Promise<string | null> {
    return postCommentOnPage(this.page, comment, { articleUrl });
  }

  // Write the CURRENT cookies back over the stored ones.
  //
  // This is the fix for the session dying between runs. Builder Center hands
  // out a token good for minutes and refreshes it while a page is open, so by
  // the time a run finishes its browser holds fresher cookies than the
  // database does. Previously that browser was destroyed and the refreshed
  // cookies with it, leaving every run to replay the same ageing snapshot
  // until it expired - which it did, in under four hours.
  //
  // Saving here means each successful visit moves the stored state forward.
  async saveRefreshedState(): Promise<{ cookies: number; saved: boolean }> {
    try {
      const localStorage = await this.page
        .evaluate(() => Object.entries(window.localStorage).map(([name, value]) => ({ name, value })))
        .catch(() => [] as Array<{ name: string; value: string }>);
      const cookies = (await this.context.cookies()).filter((cookie) => isCapturedDomain(cookie.domain));

      // Never overwrite a good blob with an empty one. A page that failed to
      // load would otherwise wipe the only working session we have.
      if (cookies.length === 0) return { cookies: 0, saved: false };

      await saveBrowserState(encryptBrowserState({ cookies, origins: [{ origin: BUILDER_ORIGIN, localStorage }] }));
      return { cookies: cookies.length, saved: true };
    } catch {
      // Refreshing the stored state is a bonus, never a reason to fail a run
      // that has already done its real work.
      return { cookies: 0, saved: false };
    }
  }

  // Let the page breathe. Builder Center refreshes its token in the
  // background, so snapshotting cookies the instant the page loads captures
  // the same values that were just restored.
  async settle(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms).catch(() => undefined);
  }

  async close(): Promise<void> { await this.browser.close(); }
}

// Playwright's connect errors carry a multi-line call log. Only the first line
// names the cause, and collecting three full logs makes the real message -
// usually "429 Too Many Requests" - impossible to find.
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]!.trim().slice(0, 160);
}

async function restoreLocalStorage(page: Page, state: BrowserState): Promise<void> {
  const builder = state.origins.find((item) => item.origin === BUILDER_ORIGIN);
  if (!builder) return;
  await page.goto(BUILDER_ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate((items) => { window.localStorage.clear(); for (const item of items) window.localStorage.setItem(item.name, item.value); }, builder.localStorage);
}
