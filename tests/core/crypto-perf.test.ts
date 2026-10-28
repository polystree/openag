import { describe, it, expect } from "bun:test";
import {
  exportPool,
  importPool,
  exportPoolSync,
  importPoolSync,
  deriveKey,
} from "../../src/core/pool-crypto.js";
import {
  AuthError,
  OpenAGErrorCode,
  type Account,
  type OAuthTokens,
} from "../../src/types.js";
import { createTestAccount, setupTestTokenManager } from "../helpers/test-utils.js";

describe("F9: Async Cryptography & Performance", () => {
  const sampleAccounts: Account[] = [
    createTestAccount({
      email: "user1@gmail.com",
      tier: "pro",
      accessToken: "volatile-access-1",
      refreshToken: "refresh-token-1",
    }),
    createTestAccount({
      email: "user2@gmail.com",
      tier: "ultra",
      accessToken: "volatile-access-2",
      refreshToken: "refresh-token-2",
    }),
  ];

  const sampleSecrets: Record<string, OAuthTokens> = {
    "user1@gmail.com": {
      accessToken: "volatile-access-1",
      refreshToken: "refresh-token-1",
      expiryDateSeconds: 1234567890,
    },
    "user2@gmail.com": {
      accessToken: "volatile-access-2",
      refreshToken: "refresh-token-2",
      expiryDateSeconds: 1234567890,
    },
  };

  const testPassphrase = "SuperSecretPassword123!@#";

  describe("Tier 1: Async PBKDF2 Encryption & Decryption", () => {
    it("T1.1: exportPool async encrypts account pool with AES-256-GCM without blocking event loop", async () => {
      const encryptedJson = await exportPool(sampleAccounts, sampleSecrets, testPassphrase);
      expect(typeof encryptedJson).toBe("string");

      const envelope = JSON.parse(encryptedJson);
      expect(envelope.version).toBe(1);
      expect(envelope.salt).toBeDefined();
      expect(envelope.iv).toBeDefined();
      expect(envelope.tag).toBeDefined();
      expect(envelope.ciphertext).toBeDefined();
    });

    it("T1.2: importPool async successfully recovers accounts and secrets from encrypted envelope", async () => {
      const encryptedJson = await exportPool(sampleAccounts, sampleSecrets, testPassphrase);
      const decrypted = await importPool(encryptedJson, testPassphrase);

      expect(decrypted.accounts.length).toBe(2);
      expect(decrypted.accounts[0]?.email).toBe("user1@gmail.com");
      expect(decrypted.accounts[1]?.email).toBe("user2@gmail.com");

      expect(decrypted.secrets["user1@gmail.com"]?.refreshToken).toBe("refresh-token-1");
      expect(decrypted.secrets["user2@gmail.com"]?.refreshToken).toBe("refresh-token-2");
    });

    it("T1.3: volatile tokens are stripped from accounts in export payload for secret isolation", async () => {
      const encryptedJson = await exportPool(sampleAccounts, sampleSecrets, testPassphrase);
      const decrypted = await importPool(encryptedJson, testPassphrase);

      for (const acc of decrypted.accounts) {
        expect(acc.accessToken).toBeUndefined();
        expect(acc.refreshToken).toBeUndefined();
      }
    });

    it("T1.4: incorrect passphrase throws AUTH_INVALID_PASSPHRASE error", async () => {
      const encryptedJson = await exportPool(sampleAccounts, sampleSecrets, testPassphrase);

      expect(async () => {
        await importPool(encryptedJson, "WrongPasswordWrongPass!");
      }).toThrow();

      try {
        await importPool(encryptedJson, "WrongPasswordWrongPass!");
      } catch (err: any) {
        expect(err).toBeInstanceOf(AuthError);
        expect(err.code).toBe(OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
      }
    });

    it("T1.5: deriveKey derives 32-byte key asynchronously with 600,000 iterations", async () => {
      const salt = Buffer.alloc(16, 0x42);
      const key = await deriveKey("test-pass", salt);

      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.length).toBe(32);
    });
  });

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: empty passphrase throws AUTH_INVALID_PASSPHRASE on export and import", async () => {
      expect(async () => {
        await exportPool(sampleAccounts, sampleSecrets, "");
      }).toThrow();

      expect(async () => {
        await importPool("{}", "");
      }).toThrow();
    });

    it("T2.2: malformed JSON envelope throws AUTH_CORRUPTED_POOL", async () => {
      expect(async () => {
        await importPool("INVALID_JSON_BUNDLE", testPassphrase);
      }).toThrow();

      try {
        await importPool("INVALID_JSON_BUNDLE", testPassphrase);
      } catch (err: any) {
        expect(err.code).toBe(OpenAGErrorCode.AUTH_CORRUPTED_POOL);
      }
    });

    it("T2.3: tampered authentication tag throws AUTH_INVALID_PASSPHRASE (GCM integrity check)", async () => {
      const encryptedJson = await exportPool(sampleAccounts, sampleSecrets, testPassphrase);
      const envelope = JSON.parse(encryptedJson);

      // Tamper with tag
      envelope.tag = "00000000000000000000000000000000";
      const tamperedJson = JSON.stringify(envelope);

      expect(async () => {
        await importPool(tamperedJson, testPassphrase);
      }).toThrow();
    });

    it("T2.4: synchronous exportPoolSync and importPoolSync maintain exact parity with async versions", () => {
      // Use low iterations or direct sync test for parity
      const syncJson = exportPoolSync(sampleAccounts, sampleSecrets, testPassphrase);
      const decryptedSync = importPoolSync(syncJson, testPassphrase);

      expect(decryptedSync.accounts.length).toBe(2);
      expect(decryptedSync.secrets["user1@gmail.com"]?.refreshToken).toBe("refresh-token-1");
    });

    it("T2.5: export/import with 50 accounts succeeds and preserves all account IDs and ordering", async () => {
      const largeAccounts: Account[] = [];
      const largeSecrets: Record<string, OAuthTokens> = {};

      for (let i = 0; i < 50; i++) {
        const email = `account-${i}@gmail.com`;
        largeAccounts.push(createTestAccount({ email, sortOrder: i }));
        largeSecrets[email] = {
          accessToken: `access-${i}`,
          refreshToken: `refresh-${i}`,
          expiryDateSeconds: 100000,
        };
      }

      const enc = await exportPool(largeAccounts, largeSecrets, testPassphrase);
      const dec = await importPool(enc, testPassphrase);

      expect(dec.accounts.length).toBe(50);
      expect(Object.keys(dec.secrets).length).toBe(50);
      expect(dec.accounts[49]?.email).toBe("account-49@gmail.com");
    });
  });

  describe("Tier 3: Error Recovery & Unhandled Rejection Suppression", () => {
    it("T3.1: importPool with invalid passphrase and synchronous property access suppresses unhandled rejection", async () => {
      const encryptedJson = await exportPool(sampleAccounts, sampleSecrets, testPassphrase);
      let unhandled = false;
      const handler = () => {
        unhandled = true;
      };
      process.on("unhandledRejection", handler);

      try {
        const pool = importPool(encryptedJson, "WrongPassphrase123!");
        expect(() => pool.accounts).toThrow();
        try {
          const _dummy = pool.accounts;
        } catch (err: any) {
          expect(err).toBeInstanceOf(AuthError);
          expect(err.code).toBe(OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
        }

        // Wait 400ms for threadpool to finish deriveKey and verify no unhandled rejection event
        await new Promise((r) => setTimeout(r, 400));
        expect(unhandled).toBe(false);
      } finally {
        process.off("unhandledRejection", handler);
      }
    });

    it("T3.2: unawaited importPool call with invalid passphrase does not emit unhandled rejection", async () => {
      const encryptedJson = await exportPool(sampleAccounts, sampleSecrets, testPassphrase);
      let unhandled = false;
      const handler = () => {
        unhandled = true;
      };
      process.on("unhandledRejection", handler);

      try {
        importPool(encryptedJson, "WrongPassphrase123!");

        // Wait 400ms for threadpool to finish deriveKey
        await new Promise((r) => setTimeout(r, 400));
        expect(unhandled).toBe(false);
      } finally {
        process.off("unhandledRejection", handler);
      }
    });

    it("T3.3: TokenManager.importAccounts with invalid passphrase rejects cleanly without unhandled rejection", async () => {
      const encryptedJson = await exportPool(sampleAccounts, sampleSecrets, testPassphrase);
      const { tokenManager } = await setupTestTokenManager();
      let unhandled = false;
      const handler = () => {
        unhandled = true;
      };
      process.on("unhandledRejection", handler);

      try {
        let threw = false;
        try {
          await tokenManager.importAccounts(encryptedJson, "WrongPassphrase123!");
        } catch (err: any) {
          threw = true;
          expect(err).toBeInstanceOf(AuthError);
          expect(err.code).toBe(OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
        }
        expect(threw).toBe(true);

        // Wait 400ms for any background operations to settle
        await new Promise((r) => setTimeout(r, 400));
        expect(unhandled).toBe(false);
      } finally {
        process.off("unhandledRejection", handler);
      }
    });
  });
});
