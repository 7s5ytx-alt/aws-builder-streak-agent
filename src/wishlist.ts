import type { Page } from "playwright-core";

// Voting on Wishlist ideas, for the 4-week wish vote streak badge: one vote a
// week for four consecutive weeks. Kept free of config and database imports
// so `npm run test:wishlist` runs this exact code against a local Chrome.

export type Wish = { url: string; title: string; votes: number };

export type VoteOutcome =
  | "voted"
  | "already-voted"
  | "unvoted-and-restored"
  | "not-found"
  | "ready-not-clicked"
  | "no-change"
  | string;

const VOTE_BUTTON = 'button[aria-label^="Vote for this wish"]';
const VOTE_MARK = "data-streak-agent-vote";

// Reads the count out of "Vote for this wish 4 votes". The count is the only
// signal this control gives: unlike the like button and the comment Submit,
// it carries no aria-pressed and no disabled state, so there is no way to see
// from the outside whether this account has already voted.
function countFromLabel(label: string | null): number | null {
  const found = /(\d+)\s+votes?\s*$/i.exec(label ?? "");
  return found ? Number(found[1]) : null;
}

export async function findWishesOnPage(page: Page, limit: number): Promise<Wish[]> {
  await page.evaluate(() => window.scrollTo(0, 400)).catch(() => undefined);
  await page.waitForTimeout(1200);

  const wishes = await page
    .evaluate((voteSelector) => {
      const byUrl = new Map<string, { url: string; title: string; votes: number }>();
      for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href*="/wishlist/"]')) {
        const url = anchor.href.split("#")[0]!;
        // The listing page itself matches /wishlist/; only an idea has a slug
        // after the id, so require at least two path segments beyond it.
        if (!/\/wishlist\/[^/]+\/[^/]+/.test(url)) continue;
        const text = (anchor.textContent ?? "").trim();
        const entry = byUrl.get(url) ?? { url, title: "", votes: 0 };
        if (text && !entry.title) entry.title = text;
        if (entry.votes === 0) {
          for (let node = anchor.parentElement; node; node = node.parentElement) {
            const button = node.querySelector(voteSelector);
            if (button) {
              const found = /(\d+)\s+votes?\s*$/i.exec(button.getAttribute("aria-label") ?? "");
              if (found) entry.votes = Number(found[1]);
              break;
            }
          }
        }
        byUrl.set(url, entry);
      }
      return [...byUrl.values()].filter((entry) => entry.title.length > 0);
    }, VOTE_BUTTON)
    .catch(() => [] as Wish[]);

  // Least-voted first. A wish with few votes gains more from one vote, and
  // the popular ones are the likeliest to have been voted already on an
  // earlier week - which here is actively dangerous, not merely wasteful.
  wishes.sort((a, b) => a.votes - b.votes);
  return wishes.slice(0, limit);
}

// Votes on one wish and proves it by the COUNT MOVING.
//
// This control is a toggle with no visible state, which makes it the most
// dangerous thing the agent touches: clicking a wish this account already
// voted for REMOVES that vote. The streak would not advance, the previous
// week's vote would be undone, and nothing on the page would say so.
//
// So the count is read before and after. Up by one means the vote landed.
// Down means it was already voted and the click removed it - which is
// repaired immediately by clicking again, and reported honestly rather than
// being dressed up as success.
export async function voteOnWishOnPage(
  page: Page,
  wishUrl: string,
  options: { click?: boolean; log?: (line: string) => void } = {},
): Promise<VoteOutcome> {
  const log = options.log ?? (() => undefined);
  const click = options.click ?? true;

  const marked = await page
    .evaluate(
      ({ url, mark, voteSelector }) => {
        document.querySelectorAll(`[${mark}]`).forEach((el) => el.removeAttribute(mark));
        const anchor = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/wishlist/"]')]
          .find((a) => a.href.split("#")[0] === url);
        if (!anchor) return false;
        for (let node = anchor.parentElement; node; node = node.parentElement) {
          const button = node.querySelector(voteSelector);
          if (button) { button.setAttribute(mark, "1"); return true; }
        }
        return false;
      },
      { url: wishUrl, mark: VOTE_MARK, voteSelector: VOTE_BUTTON },
    )
    .catch(() => false);
  if (!marked) return "not-found";

  const button = page.locator(`[${VOTE_MARK}="1"]`).first();
  if (!(await button.isVisible().catch(() => false))) return "not-found";

  const before = countFromLabel(await button.getAttribute("aria-label").catch(() => null));
  if (before === null) return "no-change";
  log(`votes before: ${before}`);

  if (!click) return "ready-not-clicked";

  await button.scrollIntoViewIfNeeded().catch(() => undefined);
  let clickError = "";
  try {
    await button.click({ timeout: 8000 });
  } catch (error) {
    clickError = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 120);
  }
  await page.waitForTimeout(2000);

  const after = countFromLabel(await button.getAttribute("aria-label").catch(() => null));
  log(`votes after: ${after}`);

  if (after !== null && after === before + 1) return "voted";

  if (after !== null && after === before - 1) {
    // Undo the damage before reporting it. Leaving the vote removed would
    // quietly cost a week that had already been earned.
    log("that removed an existing vote - clicking again to restore it");
    await button.click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(2000);
    const restored = countFromLabel(await button.getAttribute("aria-label").catch(() => null));
    return restored === before ? "already-voted" : "unvoted-and-restored";
  }

  return clickError ? `click-error: ${clickError}` : "no-change";
}
