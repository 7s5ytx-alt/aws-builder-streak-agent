import { config } from "./config.js";

export type GeneratedComment = { comment: string; evidence: string[] };

export async function generateComment(title: string, article: string): Promise<GeneratedComment> {
  if (!config.aiGatewayKey) {
    throw new Error("AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required to generate comment drafts");
  }
  const prompt = `Write one helpful AWS Builder Center comment about the article below. It must be 60-420 characters, mention a concrete idea from the article, and either add a practical observation or ask one thoughtful technical question. Do not praise generically, promote anything, invent personal experience, or make claims not supported by the article. Return JSON only: {"comment":"...","evidence":["exact supporting idea"]}.\n\nTITLE: ${title}\n\nARTICLE:\n${article.slice(0, 12000)}`;
  const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.aiGatewayKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.aiModel, messages: [{ role: "user", content: prompt }], temperature: 0.4 }),
  });
  if (!response.ok) throw new Error(`AI Gateway failed: ${response.status}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error("AI Gateway returned no comment");
  return JSON.parse(text) as GeneratedComment;
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
