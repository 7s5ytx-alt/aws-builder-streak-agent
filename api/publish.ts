import type { IncomingMessage, ServerResponse } from "node:http";
import { generateArticle } from "../src/ai.js";
import { BuilderBrowser } from "../src/browser.js";
import { config } from "../src/config.js";
import { notifyFailure } from "../src/notify.js";
import { ensurePublicationsTable, publishedThisWeek, recentPublicationTitles, recordPublication } from "../src/db.js";
import { isoWeek } from "./weekly.js";

// The 4-week article publishing streak badge, and First Article on its first
// successful run: publish at least one article every week for four
// consecutive weeks.
//
// OFF unless AUTO_PUBLISH_ARTICLES is explicitly true. This endpoint puts a
// full AI-written article on a real professional profile under a real name,
// which is a far larger exposure than a like or a comment - it stays there,
// attributed, and is what other builders judge the author by. The switch
// makes that a deliberate decision rather than a side effect of a deploy.
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

  if (!config.autoPublishArticles && !force) {
    return sendJson(response, 200, {
      ok: true,
      skipped: "AUTO_PUBLISH_ARTICLES is not true",
      note: "Set it to true to publish one article a week, or call this route with ?force=true using SETUP_SECRET.",
      week,
    });
  }

  await ensurePublicationsTable();
  if (!force && (await publishedThisWeek(week))) {
    return sendJson(response, 200, { ok: true, skipped: "already published this week", week });
  }

  let browser: BuilderBrowser | undefined;
  try {
    // Past titles are sent to the model so four weeks do not produce four
    // versions of the same article, which is what a fixed prompt tends to do.
    const previous = await recentPublicationTitles(8);
    const topic = config.articleTopics[Math.floor(Math.random() * config.articleTopics.length)]!;
    const article = await generateArticle(topic, previous);

    browser = await BuilderBrowser.connect();
    const outcome = await browser.publishArticle(article);

    if (outcome !== "published") {
      throw new Error(`Article was not published: ${outcome}. Topic was "${topic}".`);
    }

    await recordPublication(week, utcDate, article.title, topic);
    const refreshed = await browser.saveRefreshedState();

    return sendJson(response, 200, {
      ok: true,
      week,
      topic,
      title: article.title,
      words: article.body.trim().split(/\s+/).length,
      sessionRefreshed: refreshed.saved,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    const alerts = await notifyFailure(`${utcDate} (weekly article)`, message);
    return sendJson(response, 500, { ok: false, week, error: message, alerts });
  } finally {
    await browser?.close();
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
