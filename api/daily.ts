import { createHash } from "node:crypto";
import { generateComment, passesQualityGate } from "../src/ai.js";
import { BuilderBrowser } from "../src/browser.js";
import { config } from "../src/config.js";
import { beginRun, failRun, finishRun, previouslyCommented, recentCommentBodies, rememberArticle, reserveComment } from "../src/db.js";

// Hobby plans allow a configured Function duration of up to 60 seconds.
export const maxDuration = 60;

export default async function handler(request: Request): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${config.cronSecret}`) return new Response("Unauthorized", { status: 401 });
  const utcDate = new Date().toISOString().slice(0, 10);
  if (await beginRun(utcDate) === "already-completed") return Response.json({ ok: true, skipped: "already completed", utcDate });

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
    for (const article of selected) {
      const body = await browser.readArticle(article);
      await rememberArticle(article, createHash("sha256").update(body).digest("hex"));
      await browser.likeCurrentArticle();
      if (drafted >= config.commentsPerDay) continue;
      const generated = await generateComment(article.title, body);
      if (!passesQualityGate(generated, priorComments, body)) continue;
      const attempt = await reserveComment(utcDate, article.url, generated.comment.trim());
      if (attempt.status === "posted") continue;
      priorComments.push(attempt.body);
      drafted += 1;
    }
    await finishRun(utcDate);
    return Response.json({ ok: true, utcDate, articlesRead: selected.length, commentsDrafted: drafted, note: "Comment drafts require user approval before publication." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    await failRun(utcDate, message);
    return Response.json({ ok: false, utcDate, error: message }, { status: 500 });
  } finally {
    await browser?.close();
  }
}
