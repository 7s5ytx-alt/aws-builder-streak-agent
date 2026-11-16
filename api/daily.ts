import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { generateComment, passesQualityGate } from "../src/ai.js";
import { BuilderBrowser } from "../src/browser.js";
import { config } from "../src/config.js";
import { beginRun, failRun, finishRun, markCommentPosted, previouslyCommented, recentCommentBodies, recordComment, rememberArticle, reserveComment } from "../src/db.js";

// Vercel Hobby allows up to five minutes; Browser Run is still capped separately.
export const maxDuration = 300;

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.headers.authorization !== `Bearer ${config.cronSecret}`) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
  const utcDate = new Date().toISOString().slice(0, 10);
  if (await beginRun(utcDate) === "already-completed") return sendJson(response, 200, { ok: true, skipped: "already completed", utcDate });

  let browser: BuilderBrowser | undefined;
  try {
    browser = await BuilderBrowser.connect();
    const candidates = await browser.findArticles(config.articlesPerDay * 4);
    const selected = [];
    for (const candidate of candidates) {
      if (!(await previouslyCommented(candidate.url))) selected.push(candidate);
      if (selected.length === config.articlesPerDay) break;
    }
    const priorComments = await recentCommentBodies();
    let drafted = 0;
    let posted = 0;
    for (const article of selected) {
      const body = await browser.readArticle(article);
      await rememberArticle(article, createHash("sha256").update(body).digest("hex"));
      await browser.likeCurrentArticle();
      if (drafted >= config.commentsPerDay) continue;
      const generated = await generateComment(article.title, body);
      if (!passesQualityGate(generated, priorComments, body)) continue;
      // The planned text is written to the database BEFORE anything public
      // happens, so a crash mid-post cannot produce a second comment on the
      // next run: reserveComment returns the original text either way.
      const attempt = await reserveComment(utcDate, article.url, generated.comment.trim());
      if (attempt.status === "posted") continue;
      priorComments.push(attempt.body);
      drafted += 1;

      if (!config.autoPostComments) continue;
      // postComment returns null when it cannot find the comment box, which is
      // a selector problem rather than a reason to abandon the whole run - the
      // likes already landed, and the draft stays planned for a later attempt.
      const result = await browser.postComment(attempt.body);
      if (!result) continue;
      await markCommentPosted(utcDate, article.url);
      await recordComment(utcDate, article.url, attempt.body, result);
      posted += 1;
    }
    await finishRun(utcDate);
    return sendJson(response, 200, {
      ok: true,
      utcDate,
      cloudflareAccount: browser.accountUsed,
      articlesRead: selected.length,
      commentsDrafted: drafted,
      commentsPosted: posted,
      note: config.autoPostComments ? "Comments were posted automatically." : "Comment drafts require user approval before publication.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    await failRun(utcDate, message);
    return sendJson(response, 500, { ok: false, utcDate, error: message });
  } finally {
    await browser?.close();
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
