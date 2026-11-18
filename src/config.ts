// These two lists are declared BEFORE `config` on purpose.
//
// `config` is an object literal that calls queryList() and topicList() while
// it is being built. Function declarations hoist, so the calls resolve - but
// `const` does not initialize until its own line runs, so when these arrays
// sat below `config` the module threw at import:
//
//   ReferenceError: Cannot access 'DEFAULT_QUERIES' before initialization
//
// That took production down for twelve hours on 2026-11-17. tsc cannot see
// it (the temporal dead zone is a runtime ordering rule) and no local test
// imported this file, because every testable module is deliberately free of
// config imports. `npm run smoke` now imports it, which closes that hole.
const DEFAULT_QUERIES = [
  "articles",
  "comment to comment",
  "help for comments",
  "aws free comments",
  "help for aws certification",
];

const DEFAULT_TOPICS = [
  "a practical detail of AWS Lambda cost or concurrency that is easy to get wrong",
  "testing AWS integrations locally without a real AWS account",
  "reading and reducing an unexpected AWS bill line item",
  "IAM policy mistakes that fail open rather than closed",
  "making CI pipelines fail loudly instead of silently passing",
  "choosing between DynamoDB and a relational store for a specific access pattern",
  "S3 storage classes and when the lifecycle transition actually pays for itself",
];

export const config = {
  cronSecret: required("CRON_SECRET"),
  databaseUrl: required("DATABASE_URL"),
  cfAccountId: required("CF_ACCOUNT_ID"),
  cfApiToken: required("CF_API_TOKEN"),
  // Every Cloudflare account carries its own 10 free Browser Run minutes per
  // UTC day. Listing several lets a run fall through to the next one when the
  // current account answers 429, instead of losing the day. CF_ACCOUNT_ID is
  // always first; CF_ACCOUNT_ID_2..5 are optional extras.
  cfAccounts: cloudflareAccounts(),
  authStateEncryptionKey: required("AUTH_STATE_ENCRYPTION_KEY"),
  setupSecret: required("SETUP_SECRET"),
  // AI is only needed during the scheduled drafting run. Keeping this optional
  // lets the separate, owner-authenticated browser-session setup route work
  // before an AI provider is configured.
  aiGatewayKey: process.env.AI_GATEWAY_API_KEY?.trim() || process.env.VERCEL_OIDC_TOKEN?.trim(),
  // Any OpenAI-compatible chat-completions host works. Vercel AI Gateway is
  // the default, but it refuses every request until a card is on file, so
  // Google's compatibility endpoint is a usable free alternative:
  //   AI_BASE_URL = https://generativelanguage.googleapis.com/v1beta/openai
  //   AI_MODEL    = gemini-2.0-flash
  aiBaseUrl: (process.env.AI_BASE_URL?.trim() || "https://ai-gateway.vercel.sh/v1").replace(/\/+$/, ""),
  aiModel: process.env.AI_MODEL?.trim() || "openai/gpt-4o-mini",
  // Used only when the preferred model is rate-limited or overloaded. The lite
  // variants stayed available when the larger ones returned 503.
  aiModelFallback: process.env.AI_MODEL_FALLBACK?.trim() || "gemini-3.5-flash-lite",
  // Off unless explicitly enabled, and reversible without a deploy. When true
  // the daily run publishes its drafts instead of parking them for review, so
  // AI-written comments appear publicly under the owner's name unseen.
  autoPostComments: process.env.AUTO_POST_COMMENTS?.trim().toLowerCase() === "true",
  // Failure alerts. All optional: whichever pair is filled in gets used, and a
  // run never fails because an alert could not be delivered.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim(),
  telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim(),
  resendApiKey: process.env.RESEND_API_KEY?.trim(),
  alertEmailTo: process.env.ALERT_EMAIL_TO?.trim(),
  // Resend accepts this sender with no domain verification, which keeps the
  // setup to one API key. A verified domain can be used instead later.
  alertEmailFrom: process.env.ALERT_EMAIL_FROM?.trim() || "onboarding@resend.dev",
  // What the agent types into Builder Center's search box, tried in order
  // until it has enough candidates. Search returns the busy community
  // articles with their comment counts, where the home page is a carousel of
  // a couple of dozen promoted posts.
  //
  // The defaults mix general terms with phrases that surface comment-exchange
  // threads, because those reliably have comments open - and whether comments
  // are open cannot be told from the search results, only by opening the
  // article. Set SEARCH_QUERIES to a comma-separated list to point the agent
  // at technical topics instead, with no deploy needed.
  searchQueries: queryList(),
  // One like and one comment a day is the whole requirement.
  //
  // Every streak badge - 7, 30 and 90-day visit, like and comment - is scored
  // on CONSECUTIVE DAYS, never on volume. A second like earns nothing and a
  // second comment earns nothing; both just spend more of a ten-minute daily
  // browser allowance and leave more AI-written text under a real name. The
  // defaults were 3 and 2, which was triple the cost for identical progress.
  //
  // Raise them only to be visibly active rather than to earn a badge.
  // Publishing a full AI-written article under a real name on a professional
  // profile is the largest exposure this agent has, so it is off unless
  // explicitly switched on, and reversible without a deploy.
  autoPublishArticles: process.env.AUTO_PUBLISH_ARTICLES?.trim().toLowerCase() === "true",
  // Topics the weekly article is drawn from, one picked at random each week.
  articleTopics: topicList(),
  articlesPerDay: positiveInt("ARTICLES_PER_DAY", 1),
  commentsPerDay: positiveInt("COMMENTS_PER_DAY", 1),
};

// Values are trimmed because the tools that set them do not agree on line
// endings. Piping a value into `vercel env add` from PowerShell stores a
// trailing carriage return, which is a legal string but an ILLEGAL character
// in an HTTP header - so CF_API_TOKEN failed with "Invalid character in header
// content" on 2026-11-16 while the identical token worked from bash. Trimming
// here fixes every consumer at once, rather than trusting each shell that ever
// writes one of these.
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export type CloudflareAccount = { accountId: string; apiToken: string; label: string };

function cloudflareAccounts(): CloudflareAccount[] {
  const accounts: CloudflareAccount[] = [];
  const add = (idName: string, tokenName: string, label: string) => {
    const accountId = process.env[idName]?.trim();
    const apiToken = process.env[tokenName]?.trim();
    if (!accountId || !apiToken) return;
    // A half-configured extra is a silent trap: it would be skipped at the
    // moment it was most needed. Fail loudly at startup instead.
    accounts.push({ accountId, apiToken, label });
  };
  add("CF_ACCOUNT_ID", "CF_API_TOKEN", "account 1");
  for (const index of [2, 3, 4, 5]) {
    const idName = `CF_ACCOUNT_ID_${index}`;
    const tokenName = `CF_API_TOKEN_${index}`;
    const hasOne = Boolean(process.env[idName]?.trim()) !== Boolean(process.env[tokenName]?.trim());
    if (hasOne) throw new Error(`${idName} and ${tokenName} must both be set, or neither`);
    add(idName, tokenName, `account ${index}`);
  }
  if (accounts.length === 0) throw new Error("Missing required environment variable: CF_ACCOUNT_ID");
  return accounts;
}


function queryList(): string[] {
  const raw = process.env.SEARCH_QUERIES?.trim();
  if (!raw) return DEFAULT_QUERIES;
  // A stray trailing comma would otherwise search for an empty string, which
  // returns the whole site and wastes a slot.
  const queries = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return queries.length > 0 ? queries : DEFAULT_QUERIES;
}


function topicList(): string[] {
  const raw = process.env.ARTICLE_TOPICS?.trim();
  if (!raw) return DEFAULT_TOPICS;
  const topics = raw.split("|").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return topics.length > 0 ? topics : DEFAULT_TOPICS;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${name} must be an integer from 1 to 5`);
  }
  return value;
}
