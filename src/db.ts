import { sql } from "@vercel/postgres";

export type Candidate = { url: string; title: string };

export async function beginRun(utcDate: string): Promise<"start" | "already-completed"> {
  const existing = await sql<{ status: string }>`select status from daily_runs where utc_date = ${utcDate}`;
  if (existing.rows[0]?.status === "completed") return "already-completed";
  await sql`
    insert into daily_runs (utc_date, status) values (${utcDate}, 'running')
    on conflict (utc_date) do update set status = 'running', started_at = now(), error = null
  `;
  return "start";
}

export async function rememberArticle(article: Candidate, bodyHash: string): Promise<void> {
  await sql`
    insert into articles (url, title, last_read_at, body_hash)
    values (${article.url}, ${article.title}, now(), ${bodyHash})
    on conflict (url) do update set title = excluded.title, last_read_at = now(), body_hash = excluded.body_hash
  `;
}

export async function previouslyCommented(url: string): Promise<boolean> {
  const result = await sql`select 1 from posted_comments where article_url = ${url} limit 1`;
  return result.rowCount > 0;
}

export async function recentCommentBodies(): Promise<string[]> {
  const result = await sql<{ body: string }>`select body from posted_comments order by created_at desc limit 30`;
  return result.rows.map((row) => row.body);
}

export async function recordComment(utcDate: string, articleUrl: string, body: string, remoteId: string | null): Promise<void> {
  await sql`
    insert into posted_comments (utc_date, article_url, body, remote_id)
    values (${utcDate}, ${articleUrl}, ${body}, ${remoteId})
    on conflict (utc_date, article_url) do nothing
  `;
}

export async function reserveComment(utcDate: string, articleUrl: string, proposedBody: string): Promise<{ body: string; status: "planned" | "posted" }> {
  const result = await sql<{ body: string; status: "planned" | "posted" }>`
    insert into comment_attempts (utc_date, article_url, body, status)
    values (${utcDate}, ${articleUrl}, ${proposedBody}, 'planned')
    on conflict (utc_date, article_url) do update set article_url = excluded.article_url
    returning body, status
  `;
  return result.rows[0]!;
}

export async function markCommentPosted(utcDate: string, articleUrl: string): Promise<void> {
  await sql`update comment_attempts set status = 'posted' where utc_date = ${utcDate} and article_url = ${articleUrl}`;
}

export async function finishRun(utcDate: string): Promise<void> {
  await sql`update daily_runs set status = 'completed', completed_at = now() where utc_date = ${utcDate}`;
}

export async function failRun(utcDate: string, error: string): Promise<void> {
  await sql`update daily_runs set status = 'failed', error = ${error.slice(0, 2000)} where utc_date = ${utcDate}`;
}
