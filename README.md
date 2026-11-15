# AWS Builder streak agent

Cloud job for daily AWS Builder Center activity: read a small set of articles, like content, generate article-grounded comments, and record a UTC-day audit trail.

## Safety and limits

- It never stores passwords or browser cookies in the repository.
- The cloud browser profile is authenticated interactively once by its owner. If AWS re-authentication is needed, the run stops instead of attempting MFA.
- A comment is planned in the database before posting. If a run is retried, it verifies the exact planned comment on the page instead of generating or posting a duplicate.
- The current configuration caps activity at 3 articles and 2 comments per UTC day.
- The workflow cannot manufacture external likes, replies, or Wish votes; those engagement-based badges are tracked but not promised.

## Deploy

1. Install the Neon Marketplace integration from Vercel, connect it to this project, and run `db/schema.sql` in its SQL console. It injects `DATABASE_URL` automatically.
2. Install Browserbase, create a persistent Context, and sign in to AWS Builder Center manually in its live browser session. Add its API key and Context ID as `BROWSERBASE_API_KEY` and `BROWSERBASE_CONTEXT_ID`.
3. Add every variable from `.env.example` to Vercel Project Settings. Use a long random `CRON_SECRET`.
4. Install and verify locally when npm access is available:

   ```sh
   npm install
   npm run check
   ```

5. Deploy with `vercel --prod`. Vercel invokes `/api/daily` at 00:30 UTC and uses 20:00 UTC as a same-day recovery attempt. The database prevents a completed UTC day from being repeated.

## Before enabling

Test the browser selectors in a non-production run. Builder Center's HTML can change, and the `likeCurrentArticle` and `postComment` methods in `src/browser.ts` are the only site-specific selectors likely to require updates.

The AWS reward conditions are controlled by AWS. The agent records activity and gives the best chance of maintaining qualifying daily actions; it cannot guarantee badges or voucher eligibility.
