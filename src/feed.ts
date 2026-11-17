import type { Locator, Page } from "playwright-core";

// Finding and liking articles from Builder Center's search results, kept free
// of config, database and Cloudflare imports so `npm run test:search` can
// exercise the exact production code against a local Chrome. src/comment.ts
// exists for the same reason, and that split is what finally caught a bug
// that had survived two days of cloud runs.

// A search result. The comment count comes free with the card and is the best
// available signal that an article is active and still accepting comments.
export type SearchResult = { url: string; title: string; comments: number };

// Used to hand one element found inside the page to a Playwright locator, so
// the click is a real browser click with React's handlers firing, rather than
// an in-page .click() the framework may ignore.
const FEED_LIKE_MARK = "data-streak-agent-like";

// Search is an OVERLAY, not a page: typing in the box leaves the URL at
// https://builder.aws.com/ and paints results on top of the home page. There
// is no results URL to navigate to, so this drives the box the way a person
// does - and every like must be taken before anything navigates away, because
// the first page load destroys the results.
export async function searchArticlesOnPage(
  page: Page,
  query: string,
  limit: number,
  log: (line: string) => void = () => undefined,
): Promise<SearchResult[]> {
  const box = await visibleSearchBox(page);
  if (!box) { log("no visible search box"); return []; }

  await box.click({ timeout: 5000 }).catch(() => undefined);
  // Clear whatever a previous query left behind. Without this the second
  // search in a run becomes "articleshelp for comments" and quietly returns
  // nothing - a failure that looks exactly like a keyword with no matches.
  await box.fill("").catch(async () => {
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
  });
  await page.keyboard.type(query, { delay: 30 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3500);
  log(`searched for "${query}"`);

  const tab = page.getByRole("tab", { name: /^\s*articles\s*$/i }).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    log("selected the Articles tab");
  }

  const results = await page
    .evaluate(() => {
      // The home page is still mounted behind the overlay, so scraping the
      // whole document mixes promoted carousel articles into the results.
      // Scope to the smallest ancestor of the selected tab that holds several
      // article links AND a comment link - that is the results panel, and
      // nothing else on the page looks like it.
      const selected = document.querySelector('[role="tab"][aria-selected="true"]');
      let scope: Element = document.body;
      for (let node = selected?.parentElement ?? null; node; node = node.parentElement) {
        const links = node.querySelectorAll('a[href*="/content/"]');
        if (links.length >= 3 && node.querySelector('a[href*="#comments"]')) { scope = node; break; }
      }

      const byUrl = new Map<string, { url: string; title: string; comments: number }>();
      for (const anchor of scope.querySelectorAll<HTMLAnchorElement>('a[href*="/content/"]')) {
        const url = anchor.href.split("#")[0]!;
        const text = (anchor.textContent ?? "").trim();
        const entry = byUrl.get(url) ?? { url, title: "", comments: 0 };
        // The comment count IS a link, to the same article's #comments. That
        // one element gives both how busy the article is and where to comment.
        if (anchor.href.includes("#comments")) {
          const count = Number(text.replace(/[^0-9]/g, ""));
          if (Number.isFinite(count)) entry.comments = count;
        } else if (text && !entry.title) {
          entry.title = text;
        }
        byUrl.set(url, entry);
      }
      return [...byUrl.values()].filter((entry) => entry.title.length > 0);
    })
    .catch(() => [] as SearchResult[]);

  // Same ordering the merged list uses, so the likes taken from this panel go
  // to the same articles the comment step would pick.
  const ranked = rankCandidates(results);
  results.length = 0;
  results.push(...ranked);
  log(`${results.length} article(s) in the results panel`);
  return results.slice(0, limit);
}

// Runs several keywords and merges what they find.
//
// One keyword is one slice of the site. "articles" surfaces general posts,
// while phrases like "comment to comment" surface threads whose entire
// purpose is replying to each other - those practically always have comments
// open, which is the whole point of searching for them. Together they give
// the run more candidates to fall back on when one turns out closed, and
// closed is something you can only discover by opening the article.
//
// Stops as soon as there are enough candidates. Every extra query costs
// around ten seconds of a ten-minute daily browser allowance, so on a good
// day the later keywords are never run at all.
// onPanel, when given, is called with one query's results WHILE that results
// panel is still on screen. Liking has to happen there: the merged list
// returned at the end spans every query, but only the last query's cards are
// still rendered, so liking from the merged list finds nothing. A local test
// on 2026-11-17 reported not-found for three articles that had been liked
// successfully an hour earlier, which is what exposed this.
export async function searchManyOnPage(
  page: Page,
  queries: string[],
  limit: number,
  log: (line: string) => void = () => undefined,
  onPanel?: (results: SearchResult[]) => Promise<void>,
): Promise<SearchResult[]> {
  const byUrl = new Map<string, SearchResult>();

  for (const query of queries) {
    if (byUrl.size >= limit) { log(`enough candidates - skipping "${query}"`); continue; }

    const found = await searchArticlesOnPage(page, query, limit, log);
    if (onPanel && found.length > 0) await onPanel(found);
    let added = 0;
    for (const result of found) {
      // Keep the higher count when two keywords return the same article: the
      // panels are rendered at different moments and one may be stale.
      const existing = byUrl.get(result.url);
      if (!existing) { byUrl.set(result.url, result); added += 1; }
      else if (result.comments > existing.comments) byUrl.set(result.url, result);
    }
    log(`"${query}" added ${added} new (${byUrl.size} total)`);
  }

  const merged = rankCandidates([...byUrl.values()]);
  return merged.slice(0, limit);
}

// Best-first ordering for "which article should we try to comment on".
//
// Sorting by comment count alone was wrong, and a ten-article test on
// 2026-11-17 showed why: the 205-comment article was ranked first and was both
// the ONLY one with comments closed and far the slowest page to render. Two
// separate costs pull against raw popularity:
//
//   - A very high count means an old viral post. Its author is more likely to
//     have closed comments since, and the page carries hundreds of rendered
//     comments, which is minutes of a ten-minute daily browser allowance.
//   - A zero count means no evidence comments were ever accepted.
//
// So the best candidate is a moderately busy article: proven to accept
// comments recently, cheap to load. Everything outside that band is kept as a
// fallback rather than discarded, because the band is a heuristic and the only
// real test is opening the page.
export const IDEAL_COMMENTS_LOW = 10;
export const IDEAL_COMMENTS_HIGH = 80;

export function rankCandidates(results: SearchResult[]): SearchResult[] {
  const score = (result: SearchResult): number => {
    const { comments } = result;
    if (comments <= 0) return -1000;
    // Inside the band, mild preference for the busier end: more comments is
    // stronger evidence the composer is open right now.
    if (comments <= IDEAL_COMMENTS_HIGH) {
      const inBand = comments >= IDEAL_COMMENTS_LOW;
      return (inBand ? 1000 : 500) + comments;
    }
    // Above the band, the heavier the page the worse it scores, so a 205 sorts
    // below a 90 without being thrown away.
    return 1000 - comments;
  };
  return [...results].sort((a, b) => score(b) - score(a));
}

export type FeedLikeOutcome = "liked" | "already-liked" | "not-found" | "ready-not-clicked" | string;

// Likes an article from the results list without opening it. Three page loads
// saved is real money: the free Browser Run allowance is ten minutes a UTC day
// and an article page is slow to settle.
//
// Verified by aria-pressed flipping to "true" - the site confirming the like,
// as opposed to us confirming our own click. Liking blind is exactly how three
// days passed with the badge stuck while every run reported success.
export async function likeInFeedOnPage(
  page: Page,
  articleUrl: string,
  options: { click?: boolean } = {},
): Promise<FeedLikeOutcome> {
  const click = options.click ?? true;

  const marked = await page
    .evaluate(
      ({ url, mark }) => {
        document.querySelectorAll(`[${mark}]`).forEach((el) => el.removeAttribute(mark));
        const anchor = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/content/"]')]
          .find((a) => a.href.split("#")[0] === url);
        if (!anchor) return false;
        for (let node = anchor.parentElement; node; node = node.parentElement) {
          const button = node.querySelector('button[aria-label^="Like article"]');
          if (button) { button.setAttribute(mark, "1"); return true; }
        }
        return false;
      },
      { url: articleUrl, mark: FEED_LIKE_MARK },
    )
    .catch(() => false);
  if (!marked) return "not-found";

  const button = page.locator(`[${FEED_LIKE_MARK}="1"]`).first();
  if ((await button.getAttribute("aria-pressed").catch(() => null)) === "true") return "already-liked";
  if (!(await button.isVisible().catch(() => false))) return "not-found";

  // Lets the local test prove the button was found and is ready without
  // putting a like on a stranger's article to do it.
  if (!click) return "ready-not-clicked";

  await button.scrollIntoViewIfNeeded().catch(() => undefined);
  let clickError = "";
  try {
    await button.click({ timeout: 8000 });
  } catch (error) {
    clickError = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 120);
  }

  await page.waitForTimeout(1500);
  if ((await button.getAttribute("aria-pressed").catch(() => null)) === "true") return "liked";
  return clickError ? `click-error: ${clickError}` : "no-change";
}

// The header renders the search field twice, desktop and mobile, and only one
// is on screen. Taking .first() picked the hidden copy, whose click silently
// did nothing - the same class of bug as the comment box.
async function visibleSearchBox(page: Page): Promise<Locator | null> {
  const boxes = page.locator('input[type="search"], input[role="searchbox"], input[placeholder*="earch"]');
  const count = await boxes.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = boxes.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}
