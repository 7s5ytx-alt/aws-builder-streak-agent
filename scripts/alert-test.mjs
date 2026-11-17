// Sends a test failure alert through whichever channels are configured.
//
//   npm run alert:test
//
// An alert you have never seen arrive is not an alert. This proves the
// credentials work before the agent has to rely on them at 6am on a day the
// session expired.
//
// It also finds your Telegram chat id: set TELEGRAM_BOT_TOKEN alone, message
// the bot once, and run this - it prints the chat ids it can see.

import { readFileSync } from "node:fs";

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

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
const resendKey = process.env.RESEND_API_KEY?.trim();
const emailTo = process.env.ALERT_EMAIL_TO?.trim();
const emailFrom = process.env.ALERT_EMAIL_FROM?.trim() || "onboarding@resend.dev";

const SUBJECT = "Builder streak agent FAILED on 2026-01-01";
const TEXT = [
  SUBJECT,
  "",
  "AWS Builder ID session has expired; run `npm run capture:local` again",
  "",
  "ACTION: run `npm run capture:local`, sign in, press Enter. The streak breaks until you do.",
  "",
  "(This is a TEST. Nothing is actually wrong.)",
].join("\n");

let configured = 0;

console.log("");
console.log("=== TELEGRAM ===");
if (!token) {
  console.log("  not configured (TELEGRAM_BOT_TOKEN missing)");
} else if (!chatId) {
  console.log("  token set, but TELEGRAM_CHAT_ID is missing.");
  console.log("  Looking for chats that have messaged this bot...");
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const body = await response.json();
    if (!body.ok) {
      console.log("  getUpdates failed: " + JSON.stringify(body).slice(0, 200));
    } else {
      const chats = new Map();
      for (const update of body.result ?? []) {
        const chat = update.message?.chat ?? update.channel_post?.chat;
        if (chat) chats.set(chat.id, [chat.type, chat.title ?? chat.username ?? chat.first_name ?? ""].join(" "));
      }
      if (chats.size === 0) {
        console.log("  No messages seen. Open Telegram, send your bot any message, then re-run this.");
      } else {
        console.log("  Found these chat ids - put the right one in TELEGRAM_CHAT_ID:");
        for (const [id, label] of chats) console.log(`    ${id}   ${label}`);
      }
    }
  } catch (error) {
    console.log("  lookup failed: " + (error instanceof Error ? error.message : String(error)));
  }
} else {
  configured += 1;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: TEXT, disable_web_page_preview: true }),
    });
    const raw = (await response.text()).slice(0, 200);
    console.log(response.ok ? "  SENT - check Telegram" : `  FAILED  HTTP ${response.status}  ${raw}`);
  } catch (error) {
    console.log("  FAILED  " + (error instanceof Error ? error.message : String(error)));
  }
}

console.log("");
console.log("=== EMAIL (Resend) ===");
if (!resendKey || !emailTo) {
  console.log(`  not configured (${!resendKey ? "RESEND_API_KEY" : "ALERT_EMAIL_TO"} missing)`);
} else {
  configured += 1;
  console.log(`  from ${emailFrom}  ->  ${emailTo}`);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: emailFrom, to: [emailTo], subject: SUBJECT, text: TEXT }),
    });
    const raw = (await response.text()).slice(0, 240);
    console.log(response.ok ? "  SENT - check your inbox (and spam)" : `  FAILED  HTTP ${response.status}  ${raw}`);
  } catch (error) {
    console.log("  FAILED  " + (error instanceof Error ? error.message : String(error)));
  }
}

console.log("");
console.log(configured === 0
  ? "Nothing configured yet. Fill in .env.cloudflare, then run this again."
  : `${configured} channel(s) attempted. Anything that said SENT is ready to deploy.`);
