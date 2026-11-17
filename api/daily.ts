import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { generateComment, passesQualityGate } from "../src/ai.js";
import { BuilderBrowser } from "../src/browser.js";
import { config } from "../src/config.js";
import { notifyFailure } from "../src/notify.js";
import { beginRun, failRun, finishRun, markCommentPosted, previouslyCommented, recentCommentBodies, recordComment, rememberArticle, reserveComment } from "../src/db.js";

// Vercel Hobby allows up to five minutes; Browser Run is still capped separately.
export const maxDuration = 300;

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // The cron presents CRON_SECRET. The owner may also drive this by hand with
  // SETUP_SECRET, which is the only way to pass force=true - the scheduled
  // path can never re-open a finished day.
  const auth = request.headers.authorization;
  const byCron = auth === `Bearer ${config.cronSecret}`;
  const byOwner = auth === `Bearer ${config.setupSecret}`;
  if (!byCron && !byOwner) return sendJson(response, 401, { ok: false, error: "Unauthorized" });

  const force = byOwner && new URL(request.url ?? "/", `https://${request.headers.host ?? "localhost"}`).searchParams.get("force") === "true";
  const utcDate = new Date().toISOString().slice(0, 10);
  if (await beginRun(utcDate, force) === "already-completed") return sendJson(response, 200, { ok: true, skipped: "already completed", utcDate });

  // Declared out here so a failure can still report what the run managed to
  // do. Previously the throw discarded the like and post outcomes, leaving an
  // error with no evidence attached.
  const likeResults: string[] = [];
  const postOutcomes: string[] = [];

  let browser: BuilderBrowser | undefined;
  try {
    browser = await BuilderBrowser.connect();

    // Search first, home feed only as a fallback. The home page is a carousel
    // of promoted posts; search returns the busy community articles, ordered
    // here by the comment count printed on each result card.
    const wanted = config.articlesPerDay * 6;
    // Likes are taken DURING the search, while each query's results are still
    // rendered - that is the only moment their like buttons exist. Doing it
    // afterwards finds nothing, because the panel has been replaced by the
    // next query and then destroyed by the first article we open.
    // Only a FRESH like advances the streak. "already-liked" means some
    // earlier day liked it and today has done nothing, so it must not count
    // toward the quota - the agent likes the same top-ranked articles every
    // day, so the best candidates are usually ones it already liked. Counting
    // those as done would stop the run with zero new likes and break the very
    // streak it exists to keep.
    let freshLikes = 0;
    let likesExamined = 0;
    const likeFromPanel = async (results: Array<{ url: string }>) => {
      for (const result of results) {
        if (freshLikes >= config.articlesPerDay) return;
        // Bounded so a panel of entirely already-liked articles cannot spend
        // the whole browser allowance walking the list.
        if (likesExamined >= config.articlesPerDay + 8) return;
        likesExamined += 1;
        const outcome = await withTimeout(browser!.likeInFeed(result.url), 25_000, "timed-out");
        // "not-found" means no attempt was made; the article loop can still
        // like it on its own page.
        if (outcome === "not-found") continue;
        likeResults.push(outcome);
        if (outcome === "liked") freshLikes += 1;
      }
    };

    let candidates = await browser.searchArticles(config.searchQueries, wanted, likeFromPanel);
    const source = candidates.length > 0 ? `search:${config.searchQueries.length} keyword(s)` : "home-feed";
    if (candidates.length === 0) {
      candidates = (await browser.findArticlesByActivity(wanted)).map((item) => ({ ...item, comments: 0 }));
    }

    // Keep a few spare articles in hand when posting is on. Whether comments
    // are open cannot be read from the search results, only by opening the
    // article, and a ten-article test on 2026-11-17 found 1 in 10 closed.
    // Three attempts make a wasted day very unlikely, and the loop stops the
    // moment the quota is met, so the spares cost nothing on a normal day.
    const visitLimit = config.autoPostComments ? Math.max(config.articlesPerDay, 3) : config.articlesPerDay;
    const selected = [];
    for (const candidate of candidates) {
      if (!(await previouslyCommented(candidate.url))) selected.push(candidate);
      if (selected.length === visitLimit) break;
    }

    const priorComments = await recentCommentBodies();
    let drafted = 0;
    let posted = 0;
    // Vercel kills the function at maxDuration and nothing gets recorded - the
    // run is left showing "running" forever, which is worse than a clean
    // failure. Stopping early leaves room to finish, save and report.
    const deadline = Date.now() + 200_000;

    for (const article of selected) {
      if (Date.now() > deadline) {
        postOutcomes.push("stopped: out of time for more articles");
        break;
      }

      // Stop early once both quotas are met, so the extra candidates cost
      // nothing on a day when the first few articles accept comments.
      const likesDone = freshLikes >= config.articlesPerDay;
      const commentsDone = config.autoPostComments ? posted >= config.commentsPerDay : drafted >= config.commentsPerDay;
      if (likesDone && commentsDone) break;

      const body = await withTimeout(browser.readArticle(article), 45_000, "");
      if (body === "") {
        postOutcomes.push("slow-article: gave up loading it");
        continue;
      }
      await rememberArticle(article, createHash("sha256").update(body).digest("hex"));

      // Fallback only: normally the feed pass above has already met the quota
      // and this is skipped. It still runs when search was unavailable, or
      // when a card's like button could not be reached.
      if (!likesDone) {
        const liked = await browser.likeCurrentArticle();
        likeResults.push(liked);
        // Again, only a fresh like counts. An article already liked on an
        // earlier day leaves today's streak exactly where it was.
        if (liked === "liked") freshLikes += 1;
      }

      if (commentsDone) continue;
      // A bad minute at the AI provider must not cost the streak. Likes are
      // already done by this point; drafting is the optional extra, so a 429
      // or 503 skips this article instead of failing the whole run.
      let generated;
      try {
        generated = await generateComment(article.title, body);
      } catch (error) {
        postOutcomes.push(`ai-failed: ${(error instanceof Error ? error.message : "unknown").split("\n")[0].slice(0, 60)}`);
        continue;
      }
      if (!passesQualityGate(generated, priorComments, body)) continue;
      // The planned text is written to the database BEFORE anything public
      // happens, so a crash mid-post cannot produce a second comment on the
      // next run: reserveComment returns the original text either way.
      const attempt = await reserveComment(utcDate, article.url, generated.comment.trim());
      if (attempt.status === "posted") continue;
      priorComments.push(attempt.body);
      drafted += 1;

      if (!config.autoPostComments) continue;
      const result = await withTimeout(browser.postComment(attempt.body, article.url), 75_000, "timed-out");
      postOutcomes.push(`${result ?? "null"}`);

      // Only these two mean the comment is actually on the page. Everything
      // else - comments-disabled, no-composer, submit-stayed-disabled - means
      // it was NOT posted, and marking it posted would retire the draft and
      // make the article ineligible forever. The earlier version counted any
      // non-null result as success, which would have quietly lost drafts on
      // the many articles that have comments switched off.
      if (result !== "verified-in-page" && result !== "already-present") continue;

      await markCommentPosted(utcDate, article.url);
      await recordComment(utcDate, article.url, attempt.body, result);
      posted += 1;
    }
    // The like IS the streak. A run that liked nothing has not done its job,
    // however smoothly the rest went, so it must not report success - that is
    // exactly how days passed with the badge stuck while runs showed [ OK ].
    //
    // "already-liked" does not count: it means the article was liked on some
    // earlier day, which does nothing for today's streak.
    // A forced re-run is a test of the machinery, not a streak attempt, and
    // its articles are usually ones this day already liked - so the guard
    // only applies to real scheduled runs.
    const newLikes = likeResults.filter((result) => result === "liked").length;
    if (newLikes === 0 && !force) {
      throw new Error(
        `No article was liked today, so the streak does not advance. ${selected.length} article(s) read, outcomes: ${likeResults.join(", ") || "none"}.`,
      );
    }

    // Carry the refreshed cookies forward before this browser is destroyed.
    // Without this the stored session ages from the moment of capture and
    // dies within hours, regardless of how often the agent runs.
    const refreshed = await browser.saveRefreshedState();

    await finishRun(utcDate);
    return sendJson(response, 200, {
      ok: true,
      utcDate,
      sessionRefreshed: refreshed.saved,
      sessionCookies: refreshed.cookies,
      cloudflareAccount: browser.accountUsed,
      articleSource: source,
      articlesRead: selected.length,
      articlesLiked: newLikes,
      likeOutcomes: likeResults,
      commentsDrafted: drafted,
      commentsPosted: posted,
      postOutcomes,
      note: config.autoPostComments ? "Comments were posted automatically." : "Comment drafts require user approval before publication.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    await failRun(utcDate, message);
    // Recorded first, then announced. If alerting throws the failure is still
    // on record, and notifyFailure is written not to throw at all.
    const alerts = await notifyFailure(utcDate, message);
    return sendJson(response, 500, { ok: false, utcDate, error: message, likeOutcomes: likeResults, postOutcomes, alerts });
  } finally {
    await browser?.close();
  }
}

// Bounds one step so a single slow article cannot swallow the run.
//
// The deadline above is only consulted BETWEEN articles, which assumes each
// one finishes in a sensible time. A ten-article local test on 2026-11-17 saw
// pages with 200+ comments take minutes each; at that speed one article uses
// the whole budget, Vercel kills the function at maxDuration, and nothing is
// recorded at all - the run shows "running" forever, which is worse than a
// clean failure. Returning a fallback instead lets the loop move on and the
// day still finish and report.
async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
