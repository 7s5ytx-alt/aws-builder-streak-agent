# AWS Builder streak agent

Cloud job for daily AWS Builder Center activity: read a small set of articles, like content, generate article-grounded comment drafts, and record a UTC-day audit trail.

## Safety and limits

- It never stores passwords or browser cookies in the repository. The one stored AWS session is AES-256-GCM encrypted before it reaches Neon.
- The owner signs in interactively through Cloudflare Live View once. If AWS re-authentication is needed, the run stops instead of attempting MFA.
- Comment drafts are saved in the database for you to review. Public posting is intentionally a user-approved step.
- The current configuration caps activity at 3 articles and 2 comment drafts per UTC day.
- The workflow cannot manufacture external likes, replies, or Wish votes; those engagement-based badges are tracked but not promised.

## Deploy

1. Install the Neon Marketplace integration from Vercel, connect it to this project, and run `db/schema.sql` in its SQL console. It injects `DATABASE_URL` automatically.
2. Create a Cloudflare account, enable Browser Run, and create a custom API token limited to `Browser Rendering: Edit`. Add `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `AUTH_STATE_ENCRYPTION_KEY`, and `SETUP_SECRET` as Vercel secrets. Add a long random `CRON_SECRET` too.
3. Run the SQL statement at the end of `db/schema.sql` in Neon to create `encrypted_browser_state`.
4. Create a temporary Cloudflare Live View session with `GET /api/session?action=create` using `Authorization: Bearer <SETUP_SECRET>`. Open the returned `liveViewUrl`, sign in to AWS Builder Center, then call `GET /api/session?action=capture&sessionId=<id>` with the same header. The captured state is encrypted before storage.
5. Install and verify locally when npm access is available:

   ```sh
   npm install
   npm run check
   ```

6. Deploy with `vercel --prod`. Vercel invokes `/api/daily` at 00:30 UTC and uses 20:00 UTC as a same-day recovery attempt. The database prevents a completed UTC day from being repeated.

## Before enabling

Cloudflare Workers Free permits 10 Browser Run minutes per day. This job closes its browser after each run and must stay below that limit. Test selectors in a non-production run. Builder Center's HTML can change, and the `likeCurrentArticle` and `postComment` methods in `src/browser.ts` are the only site-specific selectors likely to require updates.

The AWS reward conditions are controlled by AWS. The agent records activity and gives the best chance of maintaining qualifying daily actions; it cannot guarantee badges or voucher eligibility.
