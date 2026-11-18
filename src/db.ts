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

// Read-only views used by /api/session?action=status. The daily handler writes
// its outcome to daily_runs and logs nothing to stdout, so without these the
// only record of a run lives in a database nobody can reach from a laptop.
export type RunSummary = { utcDate: string; status: string; startedAt: string; completedAt: string | null; error: string | null };

export async function recentRuns(limit: number): Promise<RunSummary[]> {
  const result = await sql`
    select utc_date, status, started_at, completed_at, error
    from daily_runs order by utc_date desc limit ${limit}
  ` as Array<{ utc_date: unknown; status: string; started_at: unknown; completed_at: unknown; error: string | null }>;
  return result.map((row) => ({
    utcDate: String(row.utc_date).slice(0, 10),
    status: row.status,
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    error: row.error,
  }));
}

export async function browserStateUpdatedAt(): Promise<string | null> {
  const result = await sql`select updated_at from encrypted_browser_state where singleton = true` as Array<{ updated_at: unknown }>;
  return result[0] ? String(result[0].updated_at) : null;
}

export async function recentDrafts(limit: number): Promise<Array<{ utcDate: string; articleUrl: string; status: string; body: string }>> {
  const result = await sql`
    select utc_date, article_url, status, body from comment_attempts order by created_at desc limit ${limit}
  ` as Array<{ utc_date: unknown; article_url: string; status: string; body: string }>;
  return result.map((row) => ({ utcDate: String(row.utc_date).slice(0, 10), articleUrl: row.article_url, status: row.status, body: row.body }));
}

// `force` re-opens a day that already completed. Only the owner-authenticated
// path sets it; the cron never does, so the once-a-day guarantee still holds
// for scheduled runs. It exists because verifying a fix otherwise means
// waiting until tomorrow.
export async function beginRun(utcDate: string, force = false): Promise<"start" | "already-completed"> {
  const existing = await sql`select status from daily_runs where utc_date = ${utcDate}` as Array<{ status: string }>;
  if (!force && existing[0]?.status === "completed") return "already-completed";
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

// --- Wishlist voting -------------------------------------------------------
//
// The vote button is a toggle with no voted-state in the DOM, so a wish voted
// last week looks identical to one never voted. Clicking it again removes the
// vote. This table is the agent's memory of what it has already voted for,
// and it is the primary guard; the count check in src/wishlist.ts is the
// safety net for votes cast outside the agent.

export async function alreadyVoted(wishUrl: string): Promise<boolean> {
  const result = await sql`select 1 from wish_votes where wish_url = ${wishUrl}` as unknown[];
  return result.length > 0;
}

export async function recordWishVote(wishUrl: string, title: string, utcDate: string, isoWeek: string): Promise<void> {
  await sql`
    insert into wish_votes (wish_url, title, utc_date, iso_week)
    values (${wishUrl}, ${title}, ${utcDate}, ${isoWeek})
    on conflict (wish_url) do nothing
  `;
}

export async function votedThisWeek(isoWeek: string): Promise<boolean> {
  const result = await sql`select 1 from wish_votes where iso_week = ${isoWeek} limit 1` as unknown[];
  return result.length > 0;
}

export async function recentWishVotes(limit: number): Promise<Array<{ wishUrl: string; title: string; isoWeek: string }>> {
  const result = await sql`
    select wish_url, title, iso_week from wish_votes order by created_at desc limit ${limit}
  ` as Array<{ wish_url: string; title: string; iso_week: string }>;
  return result.map((row) => ({ wishUrl: row.wish_url, title: row.title, isoWeek: row.iso_week }));
}

// Creates the wishlist table if it is missing, so a deploy cannot ship code
// that queries a table nobody created. The local .env files have their secrets
// redacted by `vercel env pull`, so the database is unreachable from a laptop
// and an out-of-band migration step would simply never be run. Both statements
// are "if not exists", so this costs one cheap round trip per weekly run.
export async function ensureWishVotesTable(): Promise<void> {
  await sql`
    create table if not exists wish_votes (
      wish_url text primary key,
      title text not null,
      utc_date text not null,
      iso_week text not null,
      created_at timestamptz not null default now()
    )
  `;
  await sql`create index if not exists wish_votes_iso_week on wish_votes (iso_week)`;
}

// --- Article publishing (4-week publishing streak badge) -------------------

export async function ensurePublicationsTable(): Promise<void> {
  await sql`
    create table if not exists publications (
      id serial primary key,
      iso_week text not null,
      utc_date text not null,
      title text not null,
      topic text not null,
      created_at timestamptz not null default now()
    )
  `;
  await sql`create index if not exists publications_iso_week on publications (iso_week)`;
}

export async function publishedThisWeek(isoWeek: string): Promise<boolean> {
  const result = await sql`select 1 from publications where iso_week = ${isoWeek} limit 1` as unknown[];
  return result.length > 0;
}

export async function recordPublication(isoWeek: string, utcDate: string, title: string, topic: string): Promise<void> {
  await sql`insert into publications (iso_week, utc_date, title, topic) values (${isoWeek}, ${utcDate}, ${title}, ${topic})`;
}

// Past titles steer the next article away from repeating itself; a fixed
// prompt otherwise produces four near-identical pieces over four weeks.
export async function recentPublicationTitles(limit: number): Promise<string[]> {
  const result = await sql`select title from publications order by created_at desc limit ${limit}` as Array<{ title: string }>;
  return result.map((row) => row.title);
}

// --- Articles already acted on ---------------------------------------------
//
// The agent had no memory of what it liked. Comments were recorded, likes
// were not, so every run re-examined articles it had liked days earlier and
// learned the fact only by clicking: the 2026-11-18 run reported
// ["already-liked", "liked"], having spent a card-resolve and a click
// discovering something the database could have told it instantly.
//
// Both sets are fetched ONCE per run and filtered in memory. A query per
// candidate would be twenty round trips to find three articles.

export async function ensureLikedArticlesTable(): Promise<void> {
  await sql`
    create table if not exists liked_articles (
      article_url text primary key,
      title text not null default '',
      utc_date text not null,
      created_at timestamptz not null default now()
    )
  `;
}

export async function recordLike(articleUrl: string, title: string, utcDate: string): Promise<void> {
  await sql`
    insert into liked_articles (article_url, title, utc_date)
    values (${articleUrl}, ${title}, ${utcDate})
    on conflict (article_url) do nothing
  `;
}

// Capped because this only needs to cover what search can return in one run.
// An unbounded fetch would grow forever for no benefit.
export async function likedArticleUrls(limit = 1000): Promise<Set<string>> {
  const result = await sql`
    select article_url from liked_articles order by created_at desc limit ${limit}
  ` as Array<{ article_url: string }>;
  return new Set(result.map((row) => row.article_url));
}

export async function commentedArticleUrls(limit = 1000): Promise<Set<string>> {
  const result = await sql`
    select distinct article_url from posted_comments order by article_url limit ${limit}
  ` as Array<{ article_url: string }>;
  return new Set(result.map((row) => row.article_url));
}
