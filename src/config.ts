export const config = {
  cronSecret: required("CRON_SECRET"),
  databaseUrl: required("DATABASE_URL"),
  browserWsEndpoint: required("BROWSER_WS_ENDPOINT"),
  aiGatewayKey: required("AI_GATEWAY_API_KEY"),
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
