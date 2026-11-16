import { readFileSync } from "node:fs";

// Checks every configured Cloudflare account for Browser Run access:
//
//   npm run cf:check
//
// Each account carries its own 10 free Browser Run minutes per UTC day, and
// src/browser.ts falls through to the next one when the current answers 429.
// This verifies each account independently and says which are usable now.
//
// The browser session it opens is closed immediately, so it spends seconds of
// an allowance rather than minutes.

const CF = "https://api.cloudflare.com/client/v4";

// Credentials come from the environment or from .env.cloudflare next to
// package.json. That file is matched by the .env* rule in .gitignore, so
// tokens stay out of git and out of shell history. Nothing here ever prints a
// token - only its last four characters, to confirm which one ran.
function loadLocalEnv() {
  let text;
  try { text = readFileSync(new URL("../.env.cloudflare", import.meta.url), "utf8"); }
  catch { return; }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "").trim();
    if (value && !process.env[match[1]]) process.env[match[1]] = value;
  }
}

loadLocalEnv();

function configuredAccounts() {
  const found = [];
  const pairs = [["CF_ACCOUNT_ID", "CF_API_TOKEN", "account 1"]];
  for (const index of [2, 3, 4, 5]) pairs.push([`CF_ACCOUNT_ID_${index}`, `CF_API_TOKEN_${index}`, `account ${index}`]);
  for (const [idName, tokenName, label] of pairs) {
    const accountId = process.env[idName]?.trim();
    const apiToken = process.env[tokenName]?.trim();
    if (!accountId && !apiToken) continue;
    if (!accountId || !apiToken) { found.push({ label, idName, tokenName, incomplete: true }); continue; }
    if (/^\[|SENSITIVE/.test(accountId) || /^\[|SENSITIVE/.test(apiToken)) { found.push({ label, idName, tokenName, redacted: true }); continue; }
    found.push({ label, idName, accountId, apiToken });
  }
  return found;
}

async function call(url, apiToken, init = {}) {
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${apiToken}`, ...(init.headers ?? {}) } });
  const raw = await response.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { body = { success: false, errors: [{ code: 0, message: raw.slice(0, 200) }] }; }
  return { status: response.status, body };
}

function describe(body) {
  const errors = body?.errors ?? [];
  if (errors.length) return errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
  return JSON.stringify(body).slice(0, 160);
}

async function checkAccount(account) {
  console.log("");
  console.log("=".repeat(62));
  console.log(`${account.label}  (${account.idName})`);

  if (account.incomplete) { console.log("  SKIP  only one of the id/token pair is set"); return "incomplete"; }
  if (account.redacted) { console.log("  SKIP  value is a redacted placeholder, not a real credential"); return "incomplete"; }

  console.log(`  id ...${account.accountId.slice(-6)}   token ...${account.apiToken.slice(-4)}`);

  // Cloudflare has two token types and they verify at different endpoints.
  // An Account token (cfat_...) from Manage account -> Account API tokens is
  // NOT recognised by /user/tokens/verify and reports "Invalid API Token"
  // there while being perfectly valid. Try its own account first, then fall
  // back to the user endpoint for profile-page tokens.
  const asAccount = await call(`${CF}/accounts/${account.accountId}/tokens/verify`, account.apiToken);
  let tokenOk = asAccount.status === 200 && asAccount.body?.success !== false;
  let kind = "account-scoped";
  let detail = describe(asAccount.body);
  if (!tokenOk) {
    const asUser = await call(`${CF}/user/tokens/verify`, account.apiToken);
    if (asUser.status === 200 && asUser.body?.success !== false) { tokenOk = true; kind = "user-scoped"; }
    else detail = `account: ${detail} / user: ${describe(asUser.body)}`;
  }
  console.log(`  1. token valid              ${tokenOk ? `PASS  (${kind})` : "FAIL  " + detail}`);
  // Do not stop here. Opening a browser is the only check that actually
  // matters, and a token can fail both verify endpoints yet still work.

  // keep_alive must be 10000-1200000; the floor keeps an un-closed session
  // down to ten seconds.
  const created = await call(
    `${CF}/accounts/${account.accountId}/browser-run/devtools/browser?keep_alive=10000`,
    account.apiToken,
    { method: "POST" },
  );
  const sessionId = created.body?.sessionId ?? created.body?.result?.sessionId;

  if (!sessionId) {
    const text = describe(created.body);
    const outOfBudget = created.status === 429 || /rate limit|limit exceeded/i.test(text);
    console.log(`  2. can open a browser       ${outOfBudget ? "SPENT" : "FAIL"}  HTTP ${created.status} ${text}`);
    return outOfBudget ? "spent" : "error";
  }

  console.log(`  2. can open a browser       PASS  (session ${sessionId.slice(0, 8)})`);
  const closed = await call(`${CF}/accounts/${account.accountId}/browser-run/devtools/browser/${sessionId}`, account.apiToken, { method: "DELETE" });
  console.log(`  3. session closed again     ${closed.status === 200 ? "PASS" : "FAIL  HTTP " + closed.status}`);
  return "ready";
}

const accounts = configuredAccounts();
if (accounts.length === 0) {
  console.error("No Cloudflare accounts configured. Set CF_ACCOUNT_ID and CF_API_TOKEN in .env.cloudflare.");
  process.exit(2);
}

const results = [];
for (const account of accounts) results.push([account.label, await checkAccount(account)]);

console.log("");
console.log("=".repeat(62));
console.log("SUMMARY");
for (const [label, result] of results) {
  const note = {
    ready: "usable now",
    spent: "today's 10 free minutes are gone; resets at 00:00 UTC",
    "bad-token": "token rejected - needs Browser Run: Edit on this account",
    incomplete: "not configured properly",
    error: "unexpected failure, see above",
  }[result];
  console.log(`  ${label.padEnd(12)} ${result.toUpperCase().padEnd(12)} ${note}`);
}

const usable = results.filter(([, r]) => r === "ready").length;
console.log("");
console.log(usable > 0
  ? `${usable} of ${results.length} account(s) can run right now. The agent tries them in order.`
  : "No account can run right now. Every configured account is spent or misconfigured.");
process.exit(usable > 0 ? 0 : 1);
