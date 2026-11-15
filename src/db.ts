import { neon } from "@neondatabase/serverless";
import { config } from "./config.js";

const sql = neon(config.databaseUrl);

export type Candidate = { url: string; title: string };
export type EncryptedBrowserState = { ciphertext: string; iv: string; authTag: string };

export async function loadBrowserState(): Promise<EncryptedBrowserState | null> {
  const result = await sql`
    select ciphertext, iv, auth_tag from encrypted_browser_state where singleton = true
  ` as Array<{ ciphertext: string; iv: string; auth_tag: string }>;
  const row = result[0];
  return row ? { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag } : null;
}

export async function saveBrowserState(state: EncryptedBrowserState): Promise<void> {
  await sql`
    insert into encrypted_browser_state (singleton, ciphertext, iv, auth_tag)
    values (true, ${state.ciphertext}, ${state.iv}, ${state.authTag})
    on conflict (singleton) do update set
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      updated_at = now()
  `;
}

export async function beginRun(utcDate: string): Promise<"start" | "already-completed"> {
  const existing = await sql`select status from daily_runs where utc_date = ${utcDate}` as Array<{ status: string }>;
  if (existing[0]?.status === "completed") return "already-completed";
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
  return result.length > 0;
}

export async function recentCommentBodies(): Promise<string[]> {
  const result = await sql`select body from posted_comments order by created_at desc limit 30` as Array<{ body: string }>;
  return result.map((row) => row.body);
}

export async function recordComment(utcDate: string, articleUrl: string, body: string, remoteId: string | null): Promise<void> {
  await sql`
    insert into posted_comments (utc_date, article_url, body, remote_id)
    values (${utcDate}, ${articleUrl}, ${body}, ${remoteId})
    on conflict (utc_date, article_url) do nothing
  `;
}

export async function reserveComment(utcDate: string, articleUrl: string, proposedBody: string): Promise<{ body: string; status: "planned" | "posted" }> {
  const result = await sql`
    insert into comment_attempts (utc_date, article_url, body, status)
    values (${utcDate}, ${articleUrl}, ${proposedBody}, 'planned')
    on conflict (utc_date, article_url) do update set article_url = excluded.article_url
    returning body, status
  ` as Array<{ body: string; status: "planned" | "posted" }>;
  return result[0]!;
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
