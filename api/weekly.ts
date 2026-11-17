import type { IncomingMessage, ServerResponse } from "node:http";
import { BuilderBrowser } from "../src/browser.js";
import { config } from "../src/config.js";
import { notifyFailure } from "../src/notify.js";
import { alreadyVoted, ensureWishVotesTable, recordWishVote, votedThisWeek } from "../src/db.js";

// The 4-week wish vote streak badge: vote on at least one Wishlist idea every
// week for four consecutive weeks. Separate from the daily run because the
// requirement is weekly, and because a failure here must not take the daily
// like-and-comment streak down with it.
export const maxDuration = 300;

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const auth = request.headers.authorization;
  const byCron = auth === `Bearer ${config.cronSecret}`;
  const byOwner = auth === `Bearer ${config.setupSecret}`;
  if (!byCron && !byOwner) return sendJson(response, 401, { ok: false, error: "Unauthorized" });

  const url = new URL(request.url ?? "/", `https://${request.headers.host ?? "localhost"}`);
  const force = byOwner && url.searchParams.get("force") === "true";
  const utcDate = new Date().toISOString().slice(0, 10);
  const week = isoWeek(new Date());

  await ensureWishVotesTable();

  // One vote a week is the entire requirement; more spends browser time and
  // earns nothing. The cron runs on several days so a bad day still leaves
  // chances, and this is what makes the later runs cheap no-ops.
  if (!force && (await votedThisWeek(week))) {
    return sendJson(response, 200, { ok: true, skipped: "already voted this week", week });
  }

  let browser: BuilderBrowser | undefined;
  const attempts: string[] = [];
  try {
    browser = await BuilderBrowser.connect();
    await browser.openWishlist();

    const wishes = await browser.findWishes(25);
    if (wishes.length === 0) throw new Error("No wishes found on the Wishlist page.");

    let voted: { url: string; title: string } | null = null;
    for (const wish of wishes) {
      if (voted) break;
      // The database is the primary guard. The vote control is a toggle with
      // no voted-state in the DOM, so voting again on a wish already voted
      // REMOVES that vote - it would undo an earned week rather than add one.
      if (await alreadyVoted(wish.url)) continue;

      const outcome = await browser.voteOnWish(wish.url);
      attempts.push(`${outcome}: ${wish.title.slice(0, 40)}`);

      if (outcome === "voted") {
        voted = { url: wish.url, title: wish.title };
      } else if (outcome === "already-voted" || outcome === "unvoted-and-restored") {
        // Voted outside the agent, before this table existed. Record it so it
        // is never clicked again, but it does not count for this week - the
        // vote was not cast now.
        await recordWishVote(wish.url, wish.title, utcDate, "pre-existing");
      }
    }

    if (!voted) {
      throw new Error(`No wish could be voted on. Tried ${attempts.length}: ${attempts.join("; ") || "none"}`);
    }

    await recordWishVote(voted.url, voted.title, utcDate, week);
    const refreshed = await browser.saveRefreshedState();

    return sendJson(response, 200, {
      ok: true,
      week,
      votedFor: voted.title,
      wishUrl: voted.url,
      attempts,
      sessionRefreshed: refreshed.saved,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    const alerts = await notifyFailure(`${utcDate} (weekly wish vote)`, message);
    return sendJson(response, 500, { ok: false, week, error: message, attempts, alerts });
  } finally {
    await browser?.close();
  }
}

// ISO-8601 week, e.g. "2026-W47". Used as the key for "have we voted this
// week", so it must agree with how the badge counts weeks. ISO weeks start on
// Monday, which is the common convention for streaks of this kind.
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday decides the year an ISO week belongs to.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
