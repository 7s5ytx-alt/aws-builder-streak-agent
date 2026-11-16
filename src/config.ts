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
  // Off unless explicitly enabled, and reversible without a deploy. When true
  // the daily run publishes its drafts instead of parking them for review, so
  // AI-written comments appear publicly under the owner's name unseen.
  autoPostComments: process.env.AUTO_POST_COMMENTS?.trim().toLowerCase() === "true",
  articlesPerDay: positiveInt("ARTICLES_PER_DAY", 3),
  commentsPerDay: positiveInt("COMMENTS_PER_DAY", 2),
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

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${name} must be an integer from 1 to 5`);
  }
  return value;
}
