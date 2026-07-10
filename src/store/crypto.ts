import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM encryption for per-tenant integration secrets AT REST (provider API tokens the
 * workspace enters via the Connections UI). These are OAuth-adjacent secrets, held in the
 * `tenant_config` table — NOT obligation events, so they never pass through `assertNoRawContent`
 * (same carve-out as `slack_installations`).
 *
 * The key derives from SLACK_STATE_SECRET (already a required Fly secret) so no NEW secret is
 * needed to ship this; set KEPT_CONFIG_KEY (64 hex chars = 32 bytes) to pin a dedicated key.
 * Rotating either re-keys everything, so tokens would need re-entry — acceptable for v1.
 */
function configKey(): Buffer {
  const explicit = process.env.KEPT_CONFIG_KEY;
  if (explicit && /^[0-9a-fA-F]{64}$/.test(explicit)) return Buffer.from(explicit, "hex");
  const base = process.env.SLACK_STATE_SECRET ?? explicit ?? "";
  if (!base) throw new Error("KEPT_CONFIG_KEY or SLACK_STATE_SECRET is required to encrypt tenant integration config");
  return createHash("sha256").update(`kept-config-v1:${base}`).digest(); // 32 bytes
}

/** Encrypt a UTF-8 secret → base64(iv[12] ‖ tag[16] ‖ ciphertext). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", configKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

/** Decrypt what {@link encryptSecret} produced. Throws on tamper (GCM auth) or a wrong key. */
export function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < 28) throw new Error("ciphertext too short");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", configKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Constant-time equality for comparing secrets (e.g. a webhook shared secret). */
export function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** A short, non-reversible fingerprint of a token for display ("connected · …a1b2"). Never the token. */
export function tokenHint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 4);
}
