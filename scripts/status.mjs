// Shows what the scheduled runs actually did.
//
//   npm run status
//
// The daily handler records its outcome in daily_runs and prints nothing, so
// this is the only way to see whether a run worked without database access.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENDPOINT =
  process.env.STATUS_ENDPOINT ??
  "https://aws-builder-streak-agent.vercel.app/api/session?action=status";

let setupSecret;
try {
  setupSecret = readFileSync(resolve(".setup-session-token"), "utf8").trim();
} catch {
  console.error("Could not read .setup-session-token in the project root.");
  process.exit(1);
}

const response = await fetch(ENDPOINT, { headers: { authorization: "Bearer " + setupSecret } });
const text = await response.text();

let data;
try {
  data = JSON.parse(text);
} catch {
  console.error("Unexpected reply (HTTP " + response.status + "):");
  console.error(text.slice(0, 300));
  process.exit(1);
}

if (!response.ok || data.ok === false) {
  console.error("Status request failed (HTTP " + response.status + "): " + JSON.stringify(data).slice(0, 300));
  process.exit(1);
}

const SYMBOL = { completed: "[ OK ]", failed: "[FAIL]", running: "[ .. ]" };

console.log("");
console.log("Saved AWS session : " + (data.sessionStateSavedAt ?? "NONE - run npm run capture:local"));
console.log("");

if (data.runs.length === 0) {
  console.log("No runs recorded yet.");
} else {
  console.log("RUNS (most recent first)");
  for (const run of data.runs) {
    console.log("  " + (SYMBOL[run.status] ?? "[ ?? ]") + "  " + run.utcDate + "   started " + new Date(run.startedAt).toISOString().slice(11, 16) + " UTC");
    if (run.error) {
      const first = run.error.split("\n")[0];
      // The two failures worth recognising on sight.
      const hint = /429|Rate limit/i.test(first)
        ? "  -> out of free Browser Run minutes for that UTC day; resets at 00:00 UTC"
        : /session has expired/i.test(first)
          ? "  -> run npm run capture:local to sign in again"
          : "";
      console.log("         " + first.slice(0, 150));
      if (hint) console.log("       " + hint);
    }
  }
}

console.log("");
console.log("COMMENT DRAFTS awaiting your approval: " + data.drafts.length);
for (const draft of data.drafts) {
  console.log("  [" + draft.status + "] " + draft.articleUrl);
  console.log("        " + draft.body);
}
console.log("");
