import { BuilderBrowser } from "../src/browser.js";
import { config } from "../src/config.js";

const CF = "https://api.cloudflare.com/client/v4/accounts";
const AWS_BUILDER = "https://builder.aws.com/";

export default async function handler(request: Request): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${config.setupSecret}`) return new Response("Unauthorized", { status: 401 });
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  if (action === "create") return createLiveSession();
  if (action === "capture") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !/^[a-zA-Z0-9_-]{8,200}$/.test(sessionId)) return Response.json({ ok: false, error: "A valid sessionId is required" }, { status: 400 });
    await BuilderBrowser.captureFromExistingSession(sessionId);
    return Response.json({ ok: true, message: "Encrypted AWS session state saved" });
  }
  return Response.json({ ok: false, error: "Use action=create or action=capture" }, { status: 400 });
}

async function createLiveSession(): Promise<Response> {
  const headers = { Authorization: `Bearer ${config.cfApiToken}` };
  const session = await cfFetch(`${CF}/${config.cfAccountId}/browser-run/devtools/browser?keep_alive=1200000`, { method: "POST", headers });
  const sessionId = session.sessionId as string | undefined;
  if (!sessionId) throw new Error("Cloudflare Browser Run did not return a sessionId");
  const target = await cfFetch(`${CF}/${config.cfAccountId}/browser-run/devtools/browser/${sessionId}/json/new?url=${encodeURIComponent(AWS_BUILDER)}`, { method: "PUT", headers });
  return Response.json({ ok: true, sessionId, liveViewUrl: target.devtoolsFrontendUrl, expiresIn: "The Live View URL expires in five minutes; finish AWS login then call capture before the 20-minute session ends." });
}

async function cfFetch(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const envelope = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`Cloudflare Browser Run: ${JSON.stringify(envelope)}`);
  return (envelope.result as Record<string, unknown> | undefined) ?? envelope;
}
