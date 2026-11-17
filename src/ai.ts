import { config } from "./config.js";

export type GeneratedComment = { comment: string; evidence: string[] };

export async function generateComment(title: string, article: string): Promise<GeneratedComment> {
  if (!config.aiGatewayKey) {
    throw new Error("AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required to generate comment drafts");
  }
  const prompt = `Write one helpful AWS Builder Center comment about the article below. It must be 60-420 characters, mention a concrete idea from the article, and either add a practical observation or ask one thoughtful technical question. Do not praise generically, promote anything, invent personal experience, or make claims not supported by the article. Return JSON only: {"comment":"...","evidence":["exact supporting idea"]}.\n\nTITLE: ${title}\n\nARTICLE:\n${article.slice(0, 12000)}`;
  // Try the preferred model, then the fallback.
  //
  // On 2026-11-17 Google returned 503 for gemini-3.5-flash and gemini-3.6-flash
  // for over twenty minutes while gemini-3.5-flash-lite answered normally. A
  // single hard-coded model turns a provider's bad afternoon into a missed
  // comment, so an overloaded model steps aside for a working one.
  //
  // Only 429 and 5xx fall through. A 400 or 404 is our mistake - a bad model
  // name or malformed request - and retrying elsewhere would just hide it.
  const models = [config.aiModel, config.aiModelFallback].filter((model, index, all) => model && all.indexOf(model) === index) as string[];
  let lastError = "no model attempted";

  for (const model of models) {
    const response = await fetch(`${config.aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.aiGatewayKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.4 }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 160);
      lastError = `${model}: ${response.status} ${detail}`;
      if (response.status === 429 || response.status >= 500) continue;
      throw new Error(`AI provider failed: ${lastError}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = payload.choices?.[0]?.message?.content;
    if (!text) { lastError = `${model}: returned no content`; continue; }
    return JSON.parse(stripCodeFence(text)) as GeneratedComment;
  }

  throw new Error(`AI provider failed: ${lastError}`);
}

// Models that are not OpenAI's own tend to wrap JSON in a markdown fence even
// when told to return JSON only. Gemini does this routinely, and a bare
// JSON.parse then throws on the leading backticks.
function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text.trim());
  return (fenced ? fenced[1] : text).trim();
}

export function passesQualityGate(candidate: GeneratedComment, priorComments: string[], article: string): boolean {
  const body = candidate.comment.trim();
  if (body.length < 60 || body.length > 420 || candidate.evidence.length === 0) return false;
  if (/^(great|nice|thanks|interesting)(\s|!|\.)/i.test(body)) return false;
  if (priorComments.some((prior) => similarity(prior, body) > 0.82)) return false;
  return candidate.evidence.every((item) => item.length > 8 && article.toLowerCase().includes(item.toLowerCase()));
}

function similarity(a: string, b: string): number {
  const words = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const left = words(a); const right = words(b);
  const overlap = [...left].filter((word) => right.has(word)).length;
  return overlap / Math.max(1, new Set([...left, ...right]).size);
}

export type GeneratedArticle = { title: string; description: string; body: string; tag: string };

// Drafts a short technical article for the weekly publishing streak badge.
//
// The prompt deliberately forbids invented experience and unverifiable
// claims. An article published under a real name on a professional profile is
// a much larger exposure than a comment: a wrong technical assertion stays
// there, attributed, and is what other builders judge the author by.
export async function generateArticle(topic: string, avoidTitles: string[]): Promise<GeneratedArticle> {
  if (!config.aiGatewayKey) {
    throw new Error("AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required to generate articles");
  }

  const avoid = avoidTitles.length > 0
    ? `\n\nDo not repeat or closely resemble these already-published titles:\n${avoidTitles.map((title) => `- ${title}`).join("\n")}`
    : "";

  const prompt = `Write a short, genuinely useful technical article for the AWS Builder Center about: ${topic}

Requirements:
- 450 to 900 words of plain prose. No headings markup, no bullet lists, no code fences.
- Teach one specific idea well. Concrete over general.
- State only what is verifiable from widely documented AWS behaviour.
- Never invent personal experience, benchmarks, outage stories, employers or dates.
- No marketing language, no "in today's fast-paced world", no exhortations.
- A plain, specific title. Not a question, not clickbait.
- The description is one sentence saying what the reader will learn.
- The tag is a single lowercase word or hyphenated phrase, e.g. "lambda" or "cost-optimization".${avoid}

Return JSON only: {"title":"...","description":"...","body":"...","tag":"..."}`;

  const models = [config.aiModel, config.aiModelFallback].filter((model, index, all) => model && all.indexOf(model) === index) as string[];
  let lastError = "no model attempted";

  for (const model of models) {
    const response = await fetch(`${config.aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.aiGatewayKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.6 }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 160);
      lastError = `${model}: ${response.status} ${detail}`;
      if (response.status === 429 || response.status >= 500) continue;
      throw new Error(`AI provider failed: ${lastError}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = payload.choices?.[0]?.message?.content;
    if (!text) { lastError = `${model}: returned no content`; continue; }
    const article = JSON.parse(stripCodeFence(text)) as GeneratedArticle;

    // A short body means the model returned a stub. Publishing that under
    // someone's name is worse than publishing nothing, so fail loudly.
    const words = article.body?.trim().split(/\s+/).length ?? 0;
    if (!article.title?.trim() || words < 250) {
      lastError = `${model}: article too short (${words} words)`;
      continue;
    }
    return article;
  }

  throw new Error(`AI article generation failed: ${lastError}`);
}
