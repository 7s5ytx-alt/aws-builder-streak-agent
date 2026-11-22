import type { Page } from "playwright-core";

// Reads the badge page and photographs it, so a run report can show what
// Builder Center actually credits rather than only what the agent attempted.
//
// That distinction is the whole point. Every other number in a report is the
// agent describing its own actions - and for three days those descriptions
// said "[ OK ]" while the badge sat unmoved. This is the site's account.
//
// Deliberately free of config and database imports, like comment.ts and
// feed.ts, so `npm run test:proof` exercises this exact code locally.

export type BadgeState = "earned" | "counting" | "not-started";
// progress is the real count straight from AWS, e.g. "4 of 7 days", read by
// opening the badge. Absent when the badge was not opened or showed none.
export type Badge = { name: string; state: BadgeState; progress?: string };

// The streaks the daily run works toward. Only these are opened, because
// each click costs a couple of seconds and the other fifteen badges do not
// depend on what the agent does each day.
const STREAKS_TO_OPEN = ["7-Day Visit Streak", "7-Day Like Streak", "7-Day Comment Streak"];

export type StreakProof = {
  url: string;
  signedIn: boolean;
  badges: Badge[];
  screenshot?: Uint8Array;
};

const BADGES_URL = "https://builder.aws.com/profile?tab=badges";

// The badge grid is images, not text: reading innerText returned the single
// word "Badges". The name is the img alt, and the STATE is encoded in the
// file name, which is the only machine-readable signal the page offers -
// every tile renders at opacity 1 with no CSS filter, so the obvious visual
// cues are not available to code:
//
//   ..._FirstArticle_Complete.svg              earned
//   ..._7DayLikeStreak_InProgress_Light.svg    counting, not yet earned
//   ..._ConversationStarter_NotStarted_Light.svg   nothing recorded yet
//
// "InProgress" on a streak badge is the useful one: it means AWS has
// registered activity toward that streak, which is the actual confirmation
// that the agent's work is landing.
function stateFromSource(src: string): BadgeState {
  if (/_Complete/i.test(src)) return "earned";
  if (/_NotStarted/i.test(src)) return "not-started";
  if (/_InProgress/i.test(src)) return "counting";
  return "not-started";
}

export async function captureStreakProof(
  page: Page,
  log: (line: string) => void = () => undefined,
): Promise<StreakProof> {
  await page.goto(BADGES_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.waitForTimeout(4000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

  // Signed in is judged by WHERE WE LANDED, not by a missing button.
  //
  // The button check reported "signed in: true" on 2026-11-22 while sitting
  // on the home page: requesting /profile while unauthenticated redirects to
  // "/", and on a page still rendering, the Sign in button had not appeared
  // yet. Absence of evidence read as evidence of absence - the same mistake
  // as every other silent failure in this project.
  //
  // Staying on the profile URL is positive proof: an unauthenticated request
  // cannot do it.
  const landedOnProfile = /\/profile/.test(page.url());
  if (!landedOnProfile) {
    log(`redirected to ${page.url()} - the stored session is not signed in`);
    return { url: page.url(), signedIn: false, badges: [] };
  }

  // The grid shows ten badges and hides the rest behind "Load more". A photo
  // of the first ten would miss every long streak, which is the part worth
  // proving. Bounded so a button that never disappears cannot loop forever.
  for (let round = 0; round < 6; round += 1) {
    const more = page.getByRole("button", { name: /load more/i }).first();
    if (!(await more.isVisible().catch(() => false))) break;
    await more.click({ timeout: 6000 }).catch(() => undefined);
    await page.waitForTimeout(1800);
  }

  const badges = await page
    .evaluate(() => {
      const found: Array<{ name: string; src: string }> = [];
      for (const img of [...document.querySelectorAll("img")]) {
        const rect = img.getBoundingClientRect();
        // Badge tiles are square and reasonably large; the avatar and the
        // loading spinner are not.
        if (rect.width < 40 || Math.abs(rect.width - rect.height) > 12) continue;
        const name = (img.getAttribute("alt") ?? "").trim();
        const src = img.getAttribute("src") ?? "";
        if (!name || !/DigitalBadge/i.test(src)) continue;
        found.push({ name, src });
      }
      return found;
    })
    .catch(() => [] as Array<{ name: string; src: string }>);

  const parsed: Badge[] = badges.map(({ name, src }) => ({ name, state: stateFromSource(src) }));
  log(`read ${parsed.length} badges (${parsed.filter((b) => b.state === "earned").length} earned)`);

  // Open the daily streak badges to read the real count. The grid alone only
  // says "in progress"; the panel behind a tile says "4 / 7 days", which is
  // the number actually worth sending to a phone.
  //
  // The progress is matched by walking out from the badge NAME rather than
  // taking the first "N / M days" on the page. Panels do not always close,
  // and a loose match would happily report the previous badge's number under
  // this badge's heading - the same mistake as every selector bug here.
  for (const name of STREAKS_TO_OPEN) {
    const badge = parsed.find((candidate) => candidate.name === name);
    if (!badge) continue;

    const tile = page.locator(`img[alt="${name}"]`).first();
    if (!(await tile.isVisible().catch(() => false))) continue;

    await tile.scrollIntoViewIfNeeded().catch(() => undefined);
    await tile.click({ timeout: 6000 }).catch(() => undefined);
    await page.waitForTimeout(2000);

    const progress = await page
      .evaluate((badgeName) => {
        const headings = [...document.querySelectorAll("h1, h2, h3, h4, p, span, div")]
          .filter((el) => el.textContent?.trim() === badgeName && el.getBoundingClientRect().height > 0);
        for (const heading of headings) {
          let box = heading.parentElement;
          for (let depth = 0; depth < 5 && box; depth += 1, box = box.parentElement) {
            const found = /(\d+)\s*\/\s*(\d+)\s*days?/i.exec((box as HTMLElement).innerText ?? "");
            if (found) return `${found[1]} of ${found[2]} days`;
          }
        }
        return null;
      }, name)
      .catch(() => null);

    if (progress) {
      badge.progress = progress;
      log(`${name}: ${progress}`);
    }

    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(900);
  }

  // Scroll back up so the photo starts at the top of the grid rather than
  // wherever the last "Load more" click left the page.
  await page.evaluate(() => window.scrollBy(0, -400)).catch(() => undefined);
  await page.waitForTimeout(800);

  const screenshot = await page
    .screenshot({ type: "png", fullPage: false })
    .catch((error) => {
      log("screenshot failed: " + (error instanceof Error ? error.message.split("\n")[0] : String(error)));
      return undefined;
    });

  return { url: page.url(), signedIn: true, badges: parsed, screenshot: screenshot ?? undefined };
}
