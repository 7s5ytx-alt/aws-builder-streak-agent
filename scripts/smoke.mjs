// Compiles the server code and imports every module, failing if any of them
// throws while loading.
//
//   npm run smoke
//
// This exists because of a twelve-hour outage on 2026-11-17. `config` is an
// object literal that calls queryList() while being constructed, and the
// array that function reads was declared below it with `const`. Consts do not
// initialize until their own line runs, so the module threw
// "Cannot access 'DEFAULT_QUERIES' before initialization" the moment anything
// imported it, and every endpoint returned 500 - including all the crons.
//
// Nothing caught it:
//   - tsc was happy. The temporal dead zone is a runtime ordering rule, not a
//     type error.
//   - The build succeeded. Nothing imports the API modules at build time.
//   - No local test imported it. comment.ts, feed.ts, create.ts and
//     wishlist.ts are deliberately free of config imports so they can run
//     against a local Chrome, which left config.ts as the one file that no
//     test ever loaded.
//   - No alert fired. notifyFailure lives inside each handler's catch block,
//     and this happened at MODULE LOAD, before any handler ran. A crash that
//     early is silent by construction, which is why it went unnoticed for
//     half a day.
//
// It compiles rather than using --experimental-strip-types because the source
// imports with .js extensions (right for the compiled output, unresolvable
// for strip-only mode) and because strip-only mode rejects the constructor
// parameter properties in browser.ts. Compiling first tests what actually
// runs in production.

import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Placeholders so required() does not throw. Never used to connect to
// anything: the point is only to get the modules to load.
const PLACEHOLDERS = {
  CRON_SECRET: "smoke",
  SETUP_SECRET: "smoke",
  DATABASE_URL: "postgres://user:pass@host.example.com/db",
  CF_ACCOUNT_ID: "smoke",
  CF_API_TOKEN: "smoke",
  AUTH_STATE_ENCRYPTION_KEY: "0".repeat(64),
};
for (const [name, value] of Object.entries(PLACEHOLDERS)) {
  if (!process.env[name]?.trim()) process.env[name] = value;
}

const OUT = resolve(".smoke-build");
rmSync(OUT, { recursive: true, force: true });

try {
  execFileSync("npx", ["tsc", "-p", "tsconfig.smoke.json"], { stdio: "inherit", shell: true });
} catch {
  console.error("\nCompilation failed - fix that first.");
  process.exit(1);
}

const targets = [];
for (const dir of ["src", "api"]) {
  for (const file of readdirSync(resolve(OUT, dir))) {
    if (file.endsWith(".js")) targets.push(`${dir}/${file}`);
  }
}

let failed = 0;
for (const target of targets) {
  try {
    await import(pathToFileURL(resolve(OUT, target)).href);
    console.log(`  ok    ${target}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${target}`);
    console.error(`        ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
  }
}

rmSync(OUT, { recursive: true, force: true });

console.log("");
if (failed > 0) {
  console.error(`${failed} of ${targets.length} modules failed to load. Deploying this returns 500 on every route.`);
  process.exit(1);
}
console.log(`All ${targets.length} modules load cleanly.`);
