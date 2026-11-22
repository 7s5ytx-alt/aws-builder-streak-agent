import type { IncomingMessage, ServerResponse } from "node:http";
import { BuilderBrowser, KEEPALIVE_KEEP_ALIVE_MS } from "../src/browser.js";
import { config } from "../src/config.js";
import { notifyFailure } from "../src/notify.js";

// Keeps the stored AWS session from going stale.
//
// Builder Center issues a token good for minutes and refreshes it while a page
// is open. A once-a-day agent arrives 24 hours after the last refresh, by
// which point the session is long dead - it survived under four hours when
// measured on 2026-11-17.
//
// This endpoint opens the site briefly, lets the page refresh its own token,
// writes the fresher cookies back over the stored ones, and closes. Several
// cron entries call it through the day, so the saved session is never more
// than a few hours old and the daily run always finds it alive.
//
// It is deliberately cheap: no article reading, no likes, no AI. Roughly
// fifteen seconds of browser time per call.
export const maxDuration = 120;

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const auth = request.headers.authorization;
  if (auth !== `Bearer ${config.cronSecret}` && auth !== `Bearer ${config.setupSecret}`) {
    return sendJson(response, 401, { ok: false, error: "Unauthorized" });
  }

  let browser: BuilderBrowser | undefined;
  try {
    // connect() already verifies the page is genuinely signed in and throws a
    // clear "session has expired" if not, so a dead session is reported here
    // rather than discovered by tomorrow's run.
    browser = await BuilderBrowser.connect(KEEPALIVE_KEEP_ALIVE_MS);

    // Give the page a moment to run its own refresh before we snapshot the
    // cookies. Without this pause we would save the same values we loaded.
    await browser.settle(6000);

    const refreshed = await browser.saveRefreshedState();
    return sendJson(response, 200, {
      ok: true,
      cloudflareAccount: browser.accountUsed,
      sessionRefreshed: refreshed.saved,
      cookies: refreshed.cookies,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";

    // Only shout about a dead session - that needs a human and a re-capture.
    // A Cloudflare rate limit on one keepalive is noise: the next one in two
    // hours will do the same job, and alerting every time would bury the
    // messages that matter.
    const worthAlerting = /session has expired|No encrypted AWS session/i.test(message);
    const alerts = worthAlerting ? await notifyFailure(new Date().toISOString().slice(0, 10), message) : [];
    return sendJson(response, 500, { ok: false, error: message, alerted: worthAlerting, alerts });
  } finally {
    await browser?.close();
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
