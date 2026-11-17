// Applies db/schema.sql to the database in DATABASE_URL.
//
//   npm run db:migrate
//
// Every statement is `create table if not exists` / `create index if not
// exists`, so this is safe to run repeatedly and safe to run against the live
// database. New tables added to the schema reach production this way; without
// it a deploy ships code that queries a table nobody created.

import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env.local scripts/migrate.mjs");
  process.exit(1);
}

const sql = neon(url);
const schema = readFileSync("db/schema.sql", "utf8");

// Split on semicolons at end of line, which suits this schema: it has no
// functions or dollar-quoted bodies where a semicolon could appear inside a
// statement.
const statements = schema
  .split(/;\s*$/m)
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0 && !/^--/.test(statement));

let applied = 0;
for (const statement of statements) {
  const name = /create (?:table|index)(?: if not exists)? ([\w.]+)/i.exec(statement)?.[1] ?? "statement";
  try {
    await sql.query(statement);
    console.log(`  ok    ${name}`);
    applied += 1;
  } catch (error) {
    console.error(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
console.log(`\n${applied} of ${statements.length} statements applied.`);
