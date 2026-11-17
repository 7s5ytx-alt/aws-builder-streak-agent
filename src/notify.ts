import { config } from "./config.js";

// Failure alerts. Both channels are plain HTTPS calls, so neither adds a
// dependency, and both are optional - whichever is configured gets used.
//
// This exists because a broken agent is silent. The daily handler records its
// failure in the database and returns; nothing reaches the owner. A 90-day
// streak can die on day 12 and the first sign would be the badge never
// arriving. The session expiring is the likeliest cause and needs a human.

export type AlertResult = { channel: string; ok: boolean; detail?: string };

// The two failures worth recognising on sight, so the alert says what to do
// rather than only what broke.
function hintFor(message: string): string {
  if (/session has expired|No encrypted AWS session/i.test(message)) {
    return "ACTION: run `npm run capture:local`, sign in, press Enter. The streak breaks until you do.";
  }
  if (/429|rate limit|limit exceeded/i.test(message)) {
    return "Every Cloudflare account is out of free Browser Run minutes for this UTC day. They reset at 00:00 UTC. Adding another account spreads the load.";
  }
  if (/Invalid character in header/i.test(message)) {
    return "A credential has stray whitespace in it. Re-set it on Vercel.";
  }
  if (/AI provider failed|AI provider returned/i.test(message)) {
    return "The comment model rejected the request. Likes still happened; only drafting failed.";
  }
  // A locator timeout means Builder Center's markup moved under us. It is the
  // expected way this breaks, since likeCurrentArticle and postComment are the
  // only site-specific selectors in the project.
  if (/No article was liked today/i.test(message)) {
    return "The streak did NOT advance today. Either the like button was not found (markup changed) or every article picked was already liked. Check `npm run status` for the per-article outcomes.";
  }
  if (/locator\.|waiting for locator|Timeout \d+ms exceeded/i.test(message)) {
    return "A page element was not found - Builder Center's markup has probably changed. Likes run BEFORE comments, so the streak is likely intact. Set AUTO_POST_COMMENTS=false to stop the retries while the selector is fixed.";
  }
  return "No known cause. Run `npm run status` for the full error.";
}

async function sendTelegram(text: string): Promise<AlertResult | null> {
  const token = config.telegramBotToken;
  const chatId = config.telegramChatId;
  if (!token || !chatId) return null;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (response.ok) return { channel: "telegram", ok: true };
    return { channel: "telegram", ok: false, detail: `${response.status} ${(await response.text()).slice(0, 120)}` };
  } catch (error) {
    return { channel: "telegram", ok: false, detail: error instanceof Error ? error.message : "unknown" };
  }
}

async function sendEmail(subject: string, text: string): Promise<AlertResult | null> {
  const apiKey = config.resendApiKey;
  const to = config.alertEmailTo;
  if (!apiKey || !to) return null;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: config.alertEmailFrom, to: [to], subject, text }),
    });
    if (response.ok) return { channel: "email", ok: true };
    return { channel: "email", ok: false, detail: `${response.status} ${(await response.text()).slice(0, 160)}` };
  } catch (error) {
    return { channel: "email", ok: false, detail: error instanceof Error ? error.message : "unknown" };
  }
}

// Never throws. An alert that fails must not replace the original error with
// its own, or a broken webhook would hide the very failure it exists to report.
export async function notifyFailure(utcDate: string, message: string): Promise<AlertResult[]> {
  const subject = `Builder streak agent FAILED on ${utcDate}`;
  const text = [
    subject,
    "",
    message.split("\n").slice(0, 6).join("\n"),
    "",
    hintFor(message),
  ].join("\n");

  const settled = await Promise.allSettled([sendTelegram(text), sendEmail(subject, text)]);
  const results: AlertResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled" && outcome.value) results.push(outcome.value);
    else if (outcome.status === "rejected") results.push({ channel: "unknown", ok: false, detail: String(outcome.reason).slice(0, 120) });
  }
  return results;
}
