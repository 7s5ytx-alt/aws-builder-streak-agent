import { BuilderBrowser, isCapturedDomain } from "../src/browser.js";
import { config } from "../src/config.js";
import { decryptBrowserState, encryptBrowserState, type BrowserState } from "../src/crypto.js";
import { browserStateUpdatedAt, loadBrowserState, recentDrafts, recentRuns, saveBrowserState } from "../src/db.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const CF = "https://api.cloudflare.com/client/v4/accounts";
const AWS_BUILDER = "https://builder.aws.com/";
const BUILDER_ORIGIN = "https://builder.aws.com";

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.headers.authorization !== `Bearer ${config.setupSecret}`) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
  const url = new URL(request.url ?? "/", `https://${request.headers.host ?? "localhost"}`);
  const action = url.searchParams.get("action");
  if (action === "create") return sendJson(response, 200, await createLiveSession());
  if (action === "close") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !/^[a-zA-Z0-9_-]{8,200}$/.test(sessionId)) return sendJson(response, 400, { ok: false, error: "A valid sessionId is required" });
    return sendJson(response, 200, await closeLiveSession(sessionId));
  }
  if (action === "capture") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !/^[a-zA-Z0-9_-]{8,200}$/.test(sessionId)) return sendJson(response, 400, { ok: false, error: "A valid sessionId is required" });
    await BuilderBrowser.captureFromExistingSession(sessionId);
    return sendJson(response, 200, { ok: true, message: "Encrypted AWS session state saved" });
  }
  // Accepts a signed-in state captured in a browser elsewhere. Needed for an
  // identity whose sign-in cannot complete inside Browser Run - an AWS Builder
  // ID federated through Google SSO errors on the hosted login page, so the
  // owner signs in locally and posts the resulting state here instead.
  if (action === "import") {
    if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "Use POST for action=import" });
    try {
      const state = toBrowserState(await readJsonBody(request));
      await saveBrowserState(encryptBrowserState(state));
      return sendJson(response, 200, { ok: true, message: "Encrypted AWS session state saved", cookies: state.cookies.length, origins: state.origins.length });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "Could not import the browser state" });
    }
  }
  // Read-only. The daily handler records its outcome in daily_runs and prints
  // nothing, so this is the only way to find out whether a scheduled run
  // worked without direct database access.
  if (action === "status") {
    const [runs, sessionStateSavedAt, drafts, session] = await Promise.all([recentRuns(7), browserStateUpdatedAt(), recentDrafts(5), describeStoredSession()]);
    return sendJson(response, 200, { ok: true, sessionStateSavedAt, session, runs, drafts });
  }
  return sendJson(response, 400, { ok: false, error: "Use action=create, action=capture, action=import, action=status, or action=close" });
}

// Reports WHEN the stored session dies, never what it contains. Only dates and
// counts leave this function - no cookie names, no values.
//
// This matters because the session expiring is the single thing that silently
// ends a streak, and until now the only way to find out was a failed run.
async function describeStoredSession(): Promise<Record<string, unknown>> {
  const saved = await loadBrowserState();
  if (!saved) return { stored: false, note: "No session stored. Run `npm run capture:local`." };

  let state: BrowserState;
  try { state = decryptBrowserState(saved); }
  catch { return { stored: true, readable: false, note: "Stored state could not be decrypted; AUTH_STATE_ENCRYPTION_KEY may have changed." }; }

  const now = Date.now();
  const days = (ms: number) => Math.round((ms - now) / 86_400_000);

  // Playwright reports a cookie expiry in SECONDS, and uses -1 for a session
  // cookie that dies when the browser closes. Those cannot be reasoned about,
  // so they are counted separately rather than folded into the maximum.
  const dated = state.cookies.filter((cookie) => typeof cookie.expires === "number" && cookie.expires > 0);
  const sessionOnly = state.cookies.length - dated.length;
  const soonest = dated.length ? Math.min(...dated.map((cookie) => cookie.expires * 1000)) : null;
  const latest = dated.length ? Math.max(...dated.map((cookie) => cookie.expires * 1000)) : null;

  // Builder Center records its own expiry in localStorage. Accept either an
  // epoch number or an ISO string, since the format is not documented.
  const builderEntry = state.origins.find((origin) => origin.origin === BUILDER_ORIGIN)?.localStorage.find((item) => item.name === "builderSessionExpiresAt");
  let builderExpiresAt: number | null = null;
  if (builderEntry) {
    const numeric = Number(builderEntry.value);
    const parsed = Number.isFinite(numeric) && numeric > 0 ? (numeric > 1e12 ? numeric : numeric * 1000) : Date.parse(builderEntry.value);
    if (Number.isFinite(parsed)) builderExpiresAt = parsed;
  }

  return {
    stored: true,
    readable: true,
    cookies: state.cookies.length,
    cookiesWithoutExpiry: sessionOnly,
    builderSessionExpiresAt: builderExpiresAt === null ? null : new Date(builderExpiresAt).toISOString(),
    builderSessionDaysLeft: builderExpiresAt === null ? null : days(builderExpiresAt),
    soonestCookieExpiry: soonest === null ? null : new Date(soonest).toISOString(),
    soonestCookieDaysLeft: soonest === null ? null : days(soonest),
    latestCookieExpiry: latest === null ? null : new Date(latest).toISOString(),
    latestCookieDaysLeft: latest === null ? null : days(latest),
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) throw new Error("Request body is larger than 2MB");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) throw new Error("Request body is empty");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

// The domain allowlist lives in src/browser.ts and is imported, not copied.
// The import endpoint and the refresh-on-run path must agree exactly: if one
// keeps Google's cookies and the other drops them, the session silently goes
// anonymous and every like is ignored. That is not hypothetical - it is what
// happened for two days.

function toBrowserState(payload: unknown): BrowserState {
  if (typeof payload !== "object" || payload === null) throw new Error("Expected a JSON object");
  const { cookies, origins } = payload as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(cookies)) throw new Error("Expected a cookies array");

  const kept = cookies.filter((cookie): cookie is BrowserState["cookies"][number] => {
    if (typeof cookie !== "object" || cookie === null) return false;
    const { name, value, domain } = cookie as Record<string, unknown>;
    return typeof name === "string" && name.length > 0 && typeof value === "string" && typeof domain === "string" && isCapturedDomain(domain);
  });
  if (kept.length === 0) throw new Error("No AWS or sign-in cookies in the payload; the capture was probably not signed in");

  const originList: unknown[] = Array.isArray(origins) ? origins : [];
  const keptOrigins = originList
    .filter((entry): entry is { origin: string; localStorage?: unknown } => typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).origin === "string")
    .filter((entry) => entry.origin === BUILDER_ORIGIN)
    .map((entry) => ({
      origin: entry.origin,
      localStorage: (Array.isArray(entry.localStorage) ? entry.localStorage : []).filter(
        (item: unknown): item is { name: string; value: string } =>
          typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).name === "string" && typeof (item as Record<string, unknown>).value === "string",
      ),
    }));

  return { cookies: kept, origins: keptOrigins };
}

// Browser Run bills by how long a browser stays open, and the Workers Free plan
// allows 10 minutes PER UTC DAY across every session on the account. This
// interactive sign-in is the largest single spend in the system, so the ceiling
// chosen here decides how much of the day's budget survives a login that is
// started and then abandoned.
//
// Cloudflare's bounds (developers.cloudflare.com/browser-run/limits):
//   - 60s is the DEFAULT inactivity timeout, not a cap.
//   - keep_alive may raise it to at most 20 minutes.
//   - A session stops billing as soon as it is closed; capture closes it.
// Also note the Live View URL itself stops working after 5 minutes, so a window
// longer than that only protects a tab that is already open.
const CF_KEEP_ALIVE_CEILING_MS = 1_200_000;
const FREE_DAILY_BUDGET_MS = 600_000;

// Policy: take the full eight minutes.
//
// The reasoning, since the number looks expensive against a 10-minute day:
// capture closes the session (see BuilderBrowser.captureFromExistingSession),
// so a sign-in finished in two minutes is billed two minutes. This ceiling is
// the cost of an ABANDONED login, not of a normal one. Eight minutes therefore
// buys patience for an emailed MFA code at no cost in the common case, and the
// create response below hands back a closeUrl so an abandoned login can be
// ended immediately instead of idling away the rest of the day's budget.
function loginWindowMs(): number {
  return 480_000;
}

async function createLiveSession(): Promise<Record<string, unknown>> {
  const headers = { Authorization: `Bearer ${config.cfApiToken}` };
  const keepAlive = Math.min(loginWindowMs(), CF_KEEP_ALIVE_CEILING_MS);
  const session = await cfFetch(`${CF}/${config.cfAccountId}/browser-run/devtools/browser?keep_alive=${keepAlive}`, { method: "POST", headers });
  const sessionId = session.sessionId as string | undefined;
  if (!sessionId) throw new Error("Cloudflare Browser Run did not return a sessionId");
  const target = await cfFetch(`${CF}/${config.cfAccountId}/browser-run/devtools/browser/${sessionId}/json/new?url=${encodeURIComponent(AWS_BUILDER)}`, { method: "PUT", headers });
  return {
    ok: true,
    sessionId,
    liveViewUrl: target.devtoolsFrontendUrl,
    closeUrl: `/api/session?action=close&sessionId=${sessionId}`,
    expiresIn: `The Live View URL expires in five minutes. Finish AWS login and capture within the ${Math.round(keepAlive / 60000)}-minute browser session, which uses ${Math.round((keepAlive / FREE_DAILY_BUDGET_MS) * 100)}% of a Workers Free day.`,
  };
}

async function closeLiveSession(sessionId: string): Promise<Record<string, unknown>> {
  const headers = { Authorization: `Bearer ${config.cfApiToken}` };
  const closed = await cfFetch(`${CF}/${config.cfAccountId}/browser-run/devtools/browser/${sessionId}`, { method: "DELETE", headers });
  return { ok: true, ...closed };
}

async function cfFetch(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Cloudflare Browser Run: ${response.status} ${raw.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`Cloudflare Browser Run: ${JSON.stringify(envelope)}`);
  return (envelope.result as Record<string, unknown> | undefined) ?? envelope;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
