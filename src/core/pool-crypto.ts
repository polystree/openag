import * as crypto from "node:crypto";
import { promisify } from "node:util";
import { AuthError, OpenAGErrorCode, type Account, type DecryptedPoolData, type EncryptedPoolExport, type OAuthTokens } from "../types.js";

const PBKDF2_ITERATIONS = 600000;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

const pbkdf2Async = promisify(crypto.pbkdf2);

export async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return pbkdf2Async(passphrase, salt, PBKDF2_ITERATIONS, KEY_LEN, "sha256");
}

export function deriveKeySync(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LEN, "sha256");
}

export async function exportPool(
  accounts: Account[],
  secrets: Record<string, OAuthTokens>,
  passphrase: string,
): Promise<string> {
  if (!passphrase || passphrase.length === 0) {
    throw new AuthError("Passphrase cannot be empty", OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
  }

  // SAFETY: sanitized accounts strip volatile access tokens but preserve Account entity fields
  const sanitizedAccounts = accounts.map(({ accessToken: _a, refreshToken: _r, ...rest }) => rest) as Account[];
  const payload: DecryptedPoolData = {
    accounts: sanitizedAccounts,
    secrets,
    exportedAt: Date.now(),
  };

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = await deriveKey(passphrase, salt);

  let plaintext: Buffer | null = Buffer.from(JSON.stringify(payload), "utf8");
  let ciphertext: Buffer;
  let tag: Buffer;

  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    tag = cipher.getAuthTag();
  } finally {
    key.fill(0);
    if (plaintext) {
      plaintext.fill(0);
      plaintext = null;
    }
  }

  const envelope: EncryptedPoolExport = {
    version: 1,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    createdAt: Date.now(),
  };

  return JSON.stringify(envelope, null, 2);
}

export function exportPoolSync(
  accounts: Account[],
  secrets: Record<string, OAuthTokens>,
  passphrase: string,
): string {
  if (!passphrase || passphrase.length === 0) {
    throw new AuthError("Passphrase cannot be empty", OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
  }

  const sanitizedAccounts = accounts.map(({ accessToken: _a, refreshToken: _r, ...rest }) => rest) as Account[];
  const payload: DecryptedPoolData = {
    accounts: sanitizedAccounts,
    secrets,
    exportedAt: Date.now(),
  };

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKeySync(passphrase, salt);

  let plaintext: Buffer | null = Buffer.from(JSON.stringify(payload), "utf8");
  let ciphertext: Buffer;
  let tag: Buffer;

  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    tag = cipher.getAuthTag();
  } finally {
    key.fill(0);
    if (plaintext) {
      plaintext.fill(0);
      plaintext = null;
    }
  }

  const envelope: EncryptedPoolExport = {
    version: 1,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    createdAt: Date.now(),
  };

  return JSON.stringify(envelope, null, 2);
}

function decryptEnvelopePayload(envelope: EncryptedPoolExport, key: Buffer): DecryptedPoolData {
  const iv = Buffer.from(envelope.iv, "hex");
  const tag = Buffer.from(envelope.tag, "hex");
  const ciphertext = Buffer.from(envelope.ciphertext, "hex");

  let decrypted: Buffer | null = null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (decErr) {
    throw new AuthError("Decryption failed: incorrect passphrase or corrupted data", OpenAGErrorCode.AUTH_INVALID_PASSPHRASE, decErr);
  } finally {
    key.fill(0);
  }

  let data: DecryptedPoolData;
  try {
    // SAFETY: parsing decrypted JSON payload
    data = JSON.parse(decrypted.toString("utf8")) as DecryptedPoolData;
  } catch (jsonErr) {
    throw new AuthError("Decrypted payload contains invalid JSON", OpenAGErrorCode.AUTH_CORRUPTED_POOL, jsonErr);
  } finally {
    decrypted.fill(0);
    decrypted = null;
  }

  if (!Array.isArray(data.accounts) || !data.secrets) {
    throw new AuthError("Decrypted pool data is missing required account or secret fields", OpenAGErrorCode.AUTH_CORRUPTED_POOL);
  }

  for (const acc of data.accounts) {
    if (!acc.email) {
      throw new AuthError("Invalid account data in decrypted pool", OpenAGErrorCode.AUTH_CORRUPTED_POOL);
    }
  }

  return data;
}

function parseAndValidateEnvelope(serializedJson: string, passphrase: string): { envelope: EncryptedPoolExport; salt: Buffer } {
  if (!passphrase || passphrase.length === 0) {
    throw new AuthError("Passphrase cannot be empty", OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
  }

  let envelope: EncryptedPoolExport;
  try {
    // SAFETY: parsing user-provided JSON export bundle
    envelope = JSON.parse(serializedJson.trim()) as EncryptedPoolExport;
  } catch (parseErr) {
    throw new AuthError("Invalid pool export file: malformed JSON", OpenAGErrorCode.AUTH_CORRUPTED_POOL, parseErr);
  }

  if (
    envelope.version !== 1 ||
    !envelope.salt ||
    !envelope.iv ||
    !envelope.tag ||
    !envelope.ciphertext
  ) {
    throw new AuthError("Invalid pool export envelope format", OpenAGErrorCode.AUTH_CORRUPTED_POOL);
  }

  const salt = Buffer.from(envelope.salt, "hex");
  const iv = Buffer.from(envelope.iv, "hex");
  const tag = Buffer.from(envelope.tag, "hex");

  if (salt.length !== SALT_LEN || iv.length !== IV_LEN || tag.length !== 16) {
    throw new AuthError("Corrupted encryption parameters in pool export file", OpenAGErrorCode.AUTH_CORRUPTED_POOL);
  }

  return { envelope, salt };
}

export function importPool(serializedJson: string, passphrase: string): Promise<DecryptedPoolData> & DecryptedPoolData {
  const { envelope, salt } = parseAndValidateEnvelope(serializedJson, passphrase);

  let cachedSyncResult: DecryptedPoolData | null = null;
  const getSyncResult = (): DecryptedPoolData => {
    if (!cachedSyncResult) {
      const key = deriveKeySync(passphrase, salt);
      cachedSyncResult = decryptEnvelopePayload(envelope, key);
    }
    return cachedSyncResult;
  };

  const asyncPromise = (async (): Promise<DecryptedPoolData> => {
    if (cachedSyncResult) return cachedSyncResult;
    const key = await deriveKey(passphrase, salt);
    if (cachedSyncResult) return cachedSyncResult;
    const result = decryptEnvelopePayload(envelope, key);
    cachedSyncResult = result;
    return result;
  })();

  // Attach a no-op rejection handler to suppress unhandledRejection events if the caller accesses
  // properties synchronously via getters or fails to await the returned promise.
  asyncPromise.catch(() => {});

  Object.defineProperties(asyncPromise, {
    accounts: {
      get() {
        return getSyncResult().accounts;
      },
      enumerable: true,
      configurable: true,
    },
    secrets: {
      get() {
        return getSyncResult().secrets;
      },
      enumerable: true,
      configurable: true,
    },
    exportedAt: {
      get() {
        return getSyncResult().exportedAt;
      },
      enumerable: true,
      configurable: true,
    },
  });

  return asyncPromise as Promise<DecryptedPoolData> & DecryptedPoolData;
}

export function importPoolSync(serializedJson: string, passphrase: string): DecryptedPoolData {
  const { envelope, salt } = parseAndValidateEnvelope(serializedJson, passphrase);
  const key = deriveKeySync(passphrase, salt);
  return decryptEnvelopePayload(envelope, key);
}
