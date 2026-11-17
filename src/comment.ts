import type { Page } from "playwright-core";

// The comment-posting steps, deliberately free of config, database and
// Cloudflare imports so the same code can be exercised against a local Chrome
// (`npm run test:comment`) as runs in production. Testing a copy of this logic
// would be worthless - every bug found here so far came from the details.

export type CommentOutcome =
  | "already-present"
  | "no-comment-control"
  | "comments-disabled"
  | "no-composer"
  | "editor-rejected-text"
  | "no-submit-button"
  | "submit-stayed-disabled"
  | "ready-not-submitted"
  | "verified-in-page";

// Builder Center renders the ARTICLE ITSELF in a read-only Slate editor, so an
// article page carries ~170 contenteditable elements and only the last is the
// comment box. Every selector that looks like "the Slate editor" therefore
// matches the article body first: `[data-slate-editor="true"]` and
// `.slate-editor` both do. For two days this code clicked the article text,
// typed into a read-only document and reported the composer broken.
//
// So the composer is not found by what it looks like but by what it BELONGS
// to: the editable box that goes with the Submit button we are about to press.
// That button carries aria-label="Submit comment" and is unique on the page.
// Anchoring to it means the box we type into and the button we click can never
// be two different things, which is the failure this replaces.
const SUBMIT_SELECTOR = 'button[aria-label="Submit comment"]';
const SUBMIT_LABEL = /^\s*submit comment\s*$/i;
const COMPOSER_MARK = "data-streak-agent-composer";

export async function postCommentOnPage(
  page: Page,
  comment: string,
  options: { articleUrl?: string; submit?: boolean; log?: (line: string) => void } = {},
): Promise<CommentOutcome> {
  const log = options.log ?? (() => undefined);
  const submit = options.submit ?? true;

  if (await page.getByText(comment, { exact: true }).first().isVisible().catch(() => false)) {
    return "already-present";
  }

  // Click the in-page control first. Cold-loading `url#comments` seemed tidier
  // but reported "comments aren't available" on articles the click had opened
  // minutes earlier - a single-page app renders a fresh hash load differently.
  const opener = page.getByRole("button", { name: /^\s*comment on this article/i }).first();
  if (await opener.isVisible().catch(() => false)) {
    await opener.scrollIntoViewIfNeeded().catch(() => undefined);
    await opener.click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    log("clicked 'Comment on this article'");
  } else if (options.articleUrl) {
    await page.goto(`${options.articleUrl.split("#")[0]}#comments`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForTimeout(3000);
    log("navigated to #comments (no in-page control found)");
  } else {
    return "no-comment-control";
  }

  // The composer sits below the fold and is rendered on demand, so scroll to
  // it before deciding it does not exist.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
  await page.waitForTimeout(1200);
  await page.getByRole("heading", { name: /^\s*comments?\b/i }).first().scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => undefined);

  // Look for the box BEFORE concluding comments are closed. Checking the
  // banner first meant never looking at all, and the two are not exclusive.
  const editor = await resolveComposer(page, 6000);
  if (!editor) {
    const closed = await page.getByText(/comments aren.?t available on this article/i).first().isVisible().catch(() => false);
    log(closed ? "banner: comments aren't available" : "no composer and no banner");
    return closed ? "comments-disabled" : "no-composer";
  }
  log("composer found (anchored to the Submit comment button)");

  // Type first, fall back to fill. Typing is the more faithful simulation and
  // usually works, but on 2026-11-17 a real post saw the typed text fail to
  // land and fill() carry it through to a verified comment - so the earlier
  // note here, that Slate ignores fill() outright, was wrong. Neither method
  // throws when it fails to register, which is why the check below looks for
  // the text rather than trusting either call's return.
  await editor.click({ timeout: 5000 }).catch(() => undefined);
  await page.keyboard.type(comment, { delay: 5 }).catch(() => undefined);

  // Verify by looking for OUR text. Slate renders its placeholder as a span
  // INSIDE the editor, so an empty box still reports ~58 characters and a
  // length check always passed.
  const landed = async () => ((await editor.textContent().catch(() => "")) ?? "").includes(comment.trim().slice(0, 30));
  if (!(await landed())) {
    log("typing did not land; trying fill()");
    await editor.fill(comment).catch(() => undefined);
    if (!(await landed())) return "editor-rejected-text";
  }
  log("text is in the editor");

  const submitButton = page.locator(SUBMIT_SELECTOR).first();
  if (!(await submitButton.isVisible().catch(() => false))) {
    const byRole = page.getByRole("button", { name: SUBMIT_LABEL }).first();
    if (!(await byRole.isVisible().catch(() => false))) return "no-submit-button";
  }

  // It enables only once Slate has the text, so a button still disabled here
  // means the text never reached Slate whatever the DOM shows.
  try {
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return !!el && !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true";
      },
      SUBMIT_SELECTOR,
      { timeout: 8000 },
    );
  } catch {
    return "submit-stayed-disabled";
  }
  log("Submit button is enabled");

  if (!submit) return "ready-not-submitted";

  await submitButton.click({ timeout: 8000 });
  await page.getByText(comment, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  return "verified-in-page";
}

// Marks the comment composer with a unique attribute and returns a locator for
// it, or null if the page has no composer. The search starts at the Submit
// button and walks outward, so the first editable box it meets is the one that
// button submits - the article body is many levels away and is only reached by
// a walk that would have had to pass the composer first. The read-only guard
// below is a second line of defence for the day the markup moves.
async function resolveComposer(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const marked = await page
      .evaluate(
        ({ submitSelector, mark }) => {
          document.querySelectorAll(`[${mark}]`).forEach((el) => el.removeAttribute(mark));
          const submit = document.querySelector(submitSelector);
          if (!submit) return false;

          const usable = (el: HTMLElement): boolean => {
            if (!el.isContentEditable) return false;
            if (el.getBoundingClientRect().height <= 0) return false;
            // The article's paragraphs carry a hashed `_paragraph-read-only_*`
            // class. Anything containing one is the article, not the composer.
            if (el.querySelector('[class*="read-only"]')) return false;
            if (el.closest('[class*="read-only"]')) return false;
            return true;
          };

          for (let node = submit.parentElement; node; node = node.parentElement) {
            const editable = [...node.querySelectorAll<HTMLElement>('[contenteditable="true"]')].find(usable);
            if (editable) {
              editable.setAttribute(mark, "1");
              return true;
            }
          }
          return false;
        },
        { submitSelector: SUBMIT_SELECTOR, mark: COMPOSER_MARK },
      )
      .catch(() => false);

    if (marked) return page.locator(`[${COMPOSER_MARK}="1"]`).first();
    await page.waitForTimeout(500);
  }
  return null;
}
