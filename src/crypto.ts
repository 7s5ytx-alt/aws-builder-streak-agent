import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Cookie } from "playwright-core";
import { config } from "./config.js";
import type { EncryptedBrowserState } from "./db.js";

export type BrowserState = {
  cookies: Cookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
};

function key(): Buffer {
  const value = Buffer.from(config.authStateEncryptionKey, "base64");
  if (value.length !== 32) throw new Error("AUTH_STATE_ENCRYPTION_KEY must be base64 for exactly 32 bytes");
  return value;
}

export function encryptBrowserState(state: BrowserState): EncryptedBrowserState {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
}

export function decryptBrowserState(state: EncryptedBrowserState): BrowserState {
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(state.iv, "base64"));
  decipher.setAuthTag(Buffer.from(state.authTag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(state.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as BrowserState;
}
