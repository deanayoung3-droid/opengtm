import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** SMTP/IMAP login of one mailbox, as stored (encrypted) in mailboxes.credentials_enc. */
export interface MailboxLogin {
  user: string;
  pass: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export class SecretKeyError extends Error {}

/**
 * The key that encrypts mailbox logins: MAILBOX_SECRET_KEY if set, otherwise derived from
 * UNSUBSCRIBE_SECRET (already set everywhere the app runs), so a bulk import needs no new setting.
 * Changing whichever one is used makes stored logins unreadable: import the inbox CSV again.
 */
function key(env: NodeJS.ProcessEnv): Buffer {
  const k = env.MAILBOX_SECRET_KEY || env.UNSUBSCRIBE_SECRET;
  if (!k || k.length < 16) throw new SecretKeyError("Set MAILBOX_SECRET_KEY (or UNSUBSCRIBE_SECRET), 16+ characters, to store mailbox logins");
  return createHash("sha256").update(`opengtm mailbox credentials\0${k}`).digest();
}

/** AES-256-GCM; "v1:" + base64(iv | tag | ciphertext). */
export function encryptLogin(login: MailboxLogin, env: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(env), iv);
  const body = Buffer.concat([c.update(JSON.stringify(login), "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")}`;
}

export function decryptLogin(enc: string, env: NodeJS.ProcessEnv): MailboxLogin {
  if (!enc.startsWith("v1:")) throw new SecretKeyError("unknown mailbox login format");
  const raw = Buffer.from(enc.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", key(env), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  try {
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")) as MailboxLogin;
  } catch {
    throw new SecretKeyError("mailbox login can't be decrypted (the secret key changed?): import the inbox CSV again");
  }
}
