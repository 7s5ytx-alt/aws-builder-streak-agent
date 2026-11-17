import type { Page } from "playwright-core";

// Creating content on Builder Center: a wish, a post, or an article.
//
// Covers four badges - First Wish, Conversation Starter, First Article and
// the 4-week article publishing streak. Kept free of config and database
// imports so `npm run test:create` drives this exact code against a local
// Chrome, and so a dry run can prove every step up to the publish click.
//
// Paths come from the Create menu, which is the only place they appear:
// /create/article and /create are both 404s, and the article editor actually
// lives at /create/content.
export const CREATE_PATHS = {
  wish: "/create/wish",
  post: "/create/post",
  article: "/create/content",
} as const;

export type CreateOutcome =
  | "published"
  | "ready-not-published"
  | "no-title-field"
  | "no-body-field"
  | "title-rejected"
  | "body-rejected"
  | "no-publish-button"
  | "publish-stayed-disabled"
  | string;

const ORIGIN = "https://builder.aws.com";

// Types text and proves it arrived.
//
// Builder Center uses three different editors - a plain textarea, a Slate
// editor, and a non-Slate contenteditable on the post page - and they do not
// agree on what works. fill() is silently ignored by some, typing is silently
// dropped by others, and neither throws when it fails. So: try, check, try
// the other way, check again. The check is always "is our text actually
// there", never the return value of the call.
async function enterText(page: Page, label: string, text: string, log: (line: string) => void): Promise<boolean> {
  // The probe that found these labels reported aria-label OR placeholder, and
  // the plain textareas turned out to use placeholder while the rich editors
  // use aria-label. Match both rather than rediscover which is which per page.
  const field = page.locator([
    `textarea[aria-label="${label}"]`,
    `textarea[placeholder="${label}"]`,
    `input[aria-label="${label}"]`,
    `input[placeholder="${label}"]`,
    `[contenteditable="true"][aria-label="${label}"]`,
  ].join(", ")).first();
  // WAIT for the field rather than testing it once. These editors are
  // rendered client-side and a slow load leaves the page showing skeleton
  // placeholders for several seconds; an immediate isVisible check then
  // reports the field missing when it simply has not arrived yet.
  if (!(await field.waitFor({ state: "visible", timeout: 25_000 }).then(() => true).catch(() => false))) {
    log(`field "${label}" never appeared`);
    return false;
  }

  const landed = async () => {
    const value = await field.inputValue().catch(async () => (await field.textContent().catch(() => "")) ?? "");
    return (value ?? "").includes(text.trim().slice(0, 24));
  };

  await field.click({ timeout: 5000 }).catch(() => undefined);
  await field.fill(text).catch(() => undefined);
  if (await landed()) { log(`filled "${label}"`); return true; }

  // fill() did nothing - this is the rich editor case. Type it instead.
  await page.keyboard.type(text, { delay: 4 }).catch(() => undefined);
  if (await landed()) { log(`typed into "${label}"`); return true; }

  log(`"${label}" rejected both fill and typing`);
  return false;
}

// Opens a dropdown and takes the first option. Category and tags are often
// required before the form will submit, and any valid value satisfies that -
// the badge does not care which, and guessing a specific category name would
// break the moment Builder Center renames one.
async function pickFirstOption(
  page: Page,
  buttonText: RegExp,
  log: (line: string) => void,
  prefer?: string,
): Promise<boolean> {
  const trigger = page.getByRole("button", { name: buttonText }).first();
  if (!(await trigger.isVisible().catch(() => false))) return false;

  await trigger.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(1200);

  // Match the preference against the option TEXT, rather than typing it and
  // hoping the list filters. On the wish form it does not filter at all - the
  // options were byte-identical before and after typing - so the old code
  // believed it had filtered, took the first option, and attached "Amazon
  // CodeCatalyst" to a published wish about IAM.
  //
  // These lists are also scoped by an earlier choice: picking the category
  // "Developer Tools" left 22 developer tools and no IAM at all, so no
  // spelling of the preference could ever have matched. When the preference
  // is absent, say so loudly in the log - a required field still has to be
  // filled, but a silent wrong answer is how this went out in public.
  const options = page.locator('[role="option"], [role="menuitem"], li[role="presentation"] button');
  let option = options.first();

  // Some of these lists are virtualized: the article tag dropdown renders
  // only the first 24 entries, every one beginning with "a", so a tag like
  // "automation" exists but is not in the DOM to be matched. Typing into the
  // dropdown's own combobox loads the matching entries.
  //
  // The wish service dropdown ignores typing entirely, which is why this is
  // best-effort and the text match below still runs either way.
  if (prefer) {
    const search = page.locator('[role="combobox"]').filter({ visible: true }).last();
    if (await search.isVisible().catch(() => false)) {
      await search.fill(prefer).catch(() => undefined);
      await page.waitForTimeout(1500);
    }
  }

  if (prefer) {
    const preferred = options
      .filter({ hasText: new RegExp(prefer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") })
      .first();
    if (await preferred.isVisible().catch(() => false)) {
      option = preferred;
    } else {
      // Print the WHOLE list. Six names was enough to see that the match had
      // failed but not enough to choose a better value, which meant another
      // run just to read the rest.
      const available = await options.allTextContents().catch(() => [] as string[]);
      log(`NO OPTION MATCHED "${prefer}" - falling back to the first of ${available.length}:`);
      log(`  ${available.map((text) => text.trim().slice(0, 28)).join(", ")}`);
    }
  }
  if (!(await option.isVisible().catch(() => false))) {
    log("dropdown opened but no option appeared");
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }
  const chosen = ((await option.textContent().catch(() => "")) ?? "").trim().slice(0, 30);
  await option.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  log(`chose "${chosen}"`);
  return true;
}

const SUBMIT_MARK = "data-streak-agent-submit";

async function clickSubmit(page: Page, label: RegExp, log: (line: string) => void): Promise<CreateOutcome> {
  // The post page carries FOUR buttons whose accessible name is "Create":
  // three are the navigation dropdown trigger (aria-label="Create", no text)
  // and one is the real submit (no aria-label, visible text "Create").
  // getByRole cannot tell them apart, because the accessible name is the same
  // for both, and .first() picked the nav trigger - so the form filled
  // perfectly and then nothing happened.
  //
  // The submit is the one whose own TEXT says so. Marking it in the page and
  // handing that to a locator keeps the click a real browser click.
  const marked = await page
    .evaluate(
      ({ pattern, mark }) => {
        document.querySelectorAll(`[${mark}]`).forEach((el) => el.removeAttribute(mark));
        const wanted = new RegExp(pattern, "i");
        const candidates = [...document.querySelectorAll("button")].filter((button) => {
          if (button.getBoundingClientRect().height <= 0) return false;
          return wanted.test((button.textContent ?? "").trim());
        });
        // Prefer one that is not the navigation trigger; otherwise take the
        // last, which is the form's own control in every layout seen so far.
        const target = candidates.find((button) => !button.hasAttribute("aria-label")) ?? candidates.at(-1);
        if (!target) return false;
        target.setAttribute(mark, "1");
        return true;
      },
      { pattern: label.source, mark: SUBMIT_MARK },
    )
    .catch(() => false);
  if (!marked) return "no-publish-button";

  const button = page.locator(`[${SUBMIT_MARK}="1"]`).first();
  if (!(await button.isVisible().catch(() => false))) return "no-publish-button";

  const before = page.url();
  await button.scrollIntoViewIfNeeded().catch(() => undefined);
  log(`submit disabled=${await button.isDisabled().catch(() => "?")}`);
  await button.click({ timeout: 8000 }).catch((error) => log("click failed: " + error.message.split("\n")[0]));
  await page.waitForTimeout(2500);

  // Report what the form is complaining about. A publish that silently stays
  // on the same page is the least useful possible failure: the page usually
  // says exactly which field is missing, and not reading it turns a one-line
  // fix into another round of guessing.
  const complaints = await page
    .evaluate(() =>
      [...document.querySelectorAll('[role="alert"], [aria-invalid="true"], [class*="error"], [class*="invalid"]')]
        .map((el) => (el.textContent ?? "").trim())
        .filter((text) => text.length > 0 && text.length < 160)
        .slice(0, 6))
    .catch(() => [] as string[]);
  for (const complaint of [...new Set(complaints)]) log(`form says: ${complaint}`);

  // Publishing an article opens a panel with further required choices rather
  // than submitting outright, and that panel renders no role=alert - so the
  // complaint scan above came back empty while the publish was plainly
  // blocked. Report whatever dialog is open, and the controls in it.
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
  if (await dialog.isVisible().catch(() => false)) {
    const summary = await dialog
      .evaluate((el) => {
        const text = (el as HTMLElement).innerText.replace(/\s+/g, " ").trim().slice(0, 220);
        const controls = [...el.querySelectorAll("button")]
          .filter((button) => button.getBoundingClientRect().height > 0)
          .map((button) => `"${(button.textContent ?? "").trim().slice(0, 24)}"${button.hasAttribute("disabled") ? " [disabled]" : ""}`)
          .slice(0, 10);
        return `${text}\n           buttons: ${controls.join(", ")}`;
      })
      .catch(() => "(unreadable)");
    log(`dialog open: ${summary}`);
  }

  // Publishing an article opens a "Checking" modal that scans for broken
  // links, malicious links, profanity, and title and description problems.
  // Those scans take time, and the confirm button only appears once they
  // finish - so the earlier code, which waited five seconds and then read the
  // URL, always gave up while the spinners were still turning. Nothing in the
  // DOM said so; a screenshot did.
  //
  // The modal is anchored by its Cancel button rather than role=dialog, which
  // it does not carry. The confirm is Cancel's sibling, which also guarantees
  // we never click the page's own Publish button a second time behind the
  // overlay.
  const cancel = page.getByRole("button", { name: /^\s*cancel\s*$/i }).last();
  if (await cancel.isVisible().catch(() => false)) {
    log("pre-publish checks are running");
    const deadline = Date.now() + 60_000;
    let confirmed = false;

    while (Date.now() < deadline) {
      const confirm = page
        .locator("button")
        .filter({ hasText: /^\s*(publish|continue|confirm|post)\s*$/i })
        .filter({ visible: true })
        .last();
      if ((await confirm.isVisible().catch(() => false)) && !(await confirm.isDisabled().catch(() => true))) {
        log("checks finished - confirming");
        await confirm.click({ timeout: 8000 }).catch(() => undefined);
        confirmed = true;
        break;
      }
      await page.waitForTimeout(2000);
    }
    if (!confirmed) log("the checking modal never offered a confirm button");
    await page.waitForTimeout(4000);
  }

  await page.waitForTimeout(3000);
  // Leaving the editor is the signal that it went through: a successful
  // publish navigates to the published item, while a validation failure keeps
  // you on the same editor URL with an error shown.
  const after = page.url();
  log(`url after: ${after}`);
  return after !== before && !/\/create\//.test(after) ? "published" : "publish-stayed-disabled";
}

// --- Wish (First Wish badge) ----------------------------------------------

export async function createWish(
  page: Page,
  wish: { title: string; description: string; category?: string; service?: string },
  options: { submit?: boolean; log?: (line: string) => void } = {},
): Promise<CreateOutcome> {
  const log = options.log ?? (() => undefined);
  await page.goto(ORIGIN + CREATE_PATHS.wish, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  if (!(await enterText(page, "Title", wish.title, log))) return "no-title-field";
  if (!(await enterText(page, "Description", wish.description, log))) return "body-rejected";
  await pickFirstOption(page, /choose category/i, log, wish.category);
  // Required, and not visible in the initial page probe - the form only said
  // so after a submit was refused ("AWS service is required"). Reading the
  // form's own complaint is what found it.
  await pickFirstOption(page, /aws service/i, log, wish.service);

  if (!(options.submit ?? false)) return "ready-not-published";
  return clickSubmit(page, /^\s*submit\s*$/i, log);
}

// --- Post (Conversation Starter badge) ------------------------------------

export async function createPost(
  page: Page,
  post: { title: string; body: string; space?: string },
  options: { submit?: boolean; log?: (line: string) => void } = {},
): Promise<CreateOutcome> {
  const log = options.log ?? (() => undefined);
  await page.goto(ORIGIN + CREATE_PATHS.post, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  // The post page labels its fields as questions rather than "Title"/"Body".
  if (!(await enterText(page, "What's your post about?", post.title, log))) return "no-title-field";
  if (!(await enterText(page, "What do you want to share?", post.body, log))) return "no-body-field";
  // Required: a post must be attached to a space, event or hackathon. Like
  // the wish form's AWS service field, this only surfaced as the form's own
  // complaint after a submit was refused.
  await pickFirstOption(page, /choose an event, hackathon, or space/i, log, post.space);

  if (!(options.submit ?? false)) return "ready-not-published";
  return clickSubmit(page, /^\s*create\s*$/i, log);
}

// --- Article (First Article + 4-week publishing streak badges) ------------

export async function createArticle(
  page: Page,
  article: { title: string; description: string; body: string; tag?: string },
  options: { submit?: boolean; log?: (line: string) => void } = {},
): Promise<CreateOutcome> {
  const log = options.log ?? (() => undefined);
  // Opening this path creates a draft and redirects to
  // /create/content/<id>?v=<version>, so the draft exists from this moment
  // whether or not it is ever published.
  await page.goto(ORIGIN + CREATE_PATHS.article, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  log(`draft at ${page.url()}`);

  if (!(await enterText(page, "Title", article.title, log))) return "no-title-field";
  if (!(await enterText(page, "Description", article.description, log))) return "title-rejected";
  if (!(await enterText(page, "Body", article.body, log))) return "no-body-field";
  await pickFirstOption(page, /choose tags/i, log, article.tag);

  if (!(options.submit ?? false)) return "ready-not-published";
  return clickSubmit(page, /^\s*publish\s*$/i, log);
}
