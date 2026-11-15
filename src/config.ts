export const config = {
  cronSecret: required("CRON_SECRET"),
  databaseUrl: required("DATABASE_URL"),
  cfAccountId: required("CF_ACCOUNT_ID"),
  cfApiToken: required("CF_API_TOKEN"),
  authStateEncryptionKey: required("AUTH_STATE_ENCRYPTION_KEY"),
  setupSecret: required("SETUP_SECRET"),
  aiGatewayKey: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN ?? required("AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN"),
  aiModel: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
  articlesPerDay: positiveInt("ARTICLES_PER_DAY", 3),
  commentsPerDay: positiveInt("COMMENTS_PER_DAY", 2),
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${name} must be an integer from 1 to 5`);
  }
  return value;
}
