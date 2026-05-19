import { CredentialEncryptionService } from "../credential-encryption.service";

describe("CredentialEncryptionService", () => {
  const VALID_KEY = "a".repeat(64); // 32 bytes as hex
  const OLD_KEY   = "b".repeat(64);
  let service: CredentialEncryptionService;

  beforeEach(() => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_ID;
    process.env.CREDENTIAL_ENCRYPTION_KEY = VALID_KEY;
    service = new CredentialEncryptionService();
  });

  afterEach(() => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_ID;
  });

  describe("encrypt / decrypt roundtrip", () => {
    it("decrypts to the original plaintext credentials", () => {
      const original = {
        accessToken: "tok_abc123",
        clientId: "client-xyz",
        webhookSecret: "wh-secret",
        nested: undefined,
      };
      const encrypted = service.encrypt(original as any);
      expect(encrypted).not.toEqual(original);
      expect((encrypted as any).accessToken).toBeUndefined();

      const decrypted = service.decrypt(encrypted as any);
      expect(decrypted).toEqual(original);
    });

    it("produces a different ciphertext each call (random IV)", () => {
      const creds = { accessToken: "tok_abc123" };
      const enc1 = service.encrypt(creds);
      const enc2 = service.encrypt(creds);
      expect((enc1 as any).ct).not.toBe((enc2 as any).ct);
      expect((enc1 as any).iv).not.toBe((enc2 as any).iv);
    });

    it("includes v, alg, iv, tag, ct, kid in the envelope", () => {
      const encrypted = service.encrypt({ key: "value" }) as any;
      expect(encrypted.v).toBe(1);
      expect(encrypted.alg).toBe("aes-256-gcm");
      expect(typeof encrypted.iv).toBe("string");
      expect(typeof encrypted.tag).toBe("string");
      expect(typeof encrypted.ct).toBe("string");
      expect(typeof encrypted.kid).toBe("string");
    });

    it("stores the current key ID in the kid field", () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT = VALID_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "v2";
      const svc = new CredentialEncryptionService();
      const enc = svc.encrypt({ x: 1 }) as any;
      expect(enc.kid).toBe("v2");
    });
  });

  describe("isEncrypted", () => {
    it("returns true for a valid encrypted envelope", () => {
      const encrypted = service.encrypt({ foo: "bar" });
      expect(service.isEncrypted(encrypted)).toBe(true);
    });

    it("returns false for plaintext credentials", () => {
      expect(service.isEncrypted({ accessToken: "tok_abc" })).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(service.isEncrypted(null)).toBe(false);
      expect(service.isEncrypted(undefined)).toBe(false);
    });
  });

  describe("decrypt with plaintext (lazy migration path)", () => {
    it("returns plaintext unchanged when passed non-encrypted credentials", () => {
      const plain = { accessToken: "tok_abc", clientId: "cid" };
      const result = service.decrypt(plain as any);
      expect(result).toEqual(plain);
    });
  });

  describe("authentication", () => {
    it("throws on tampered ciphertext (GCM auth tag check)", () => {
      const encrypted = service.encrypt({ secret: "value" }) as any;
      encrypted.ct = "deadbeef" + encrypted.ct.slice(8);

      expect(() => service.decrypt(encrypted)).toThrow();
    });

    it("throws when auth tag is tampered", () => {
      const encrypted = service.encrypt({ secret: "value" }) as any;
      encrypted.tag = "00".repeat(16);

      expect(() => service.decrypt(encrypted)).toThrow();
    });
  });

  describe("missing key handling", () => {
    it("in dev mode (non-production) with no key, encrypt is a passthrough", () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      const noKeySvc = new CredentialEncryptionService();
      const creds = { accessToken: "tok" };
      const result = noKeySvc.encrypt(creds as any);
      expect(result).toEqual(creds);
    });

    it("in production mode, throws if key is missing", () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        expect(() => new CredentialEncryptionService()).toThrow(
          "CREDENTIAL_ENCRYPTION_KEY",
        );
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it("throws if key length is wrong", () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY = "tooshort";
      expect(() => new CredentialEncryptionService()).toThrow("64 hex characters");
    });

    it("CREDENTIAL_ENCRYPTION_KEY_CURRENT takes precedence over legacy key", () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT = VALID_KEY;
      const svc = new CredentialEncryptionService();
      const enc = svc.encrypt({ x: 1 });
      expect(svc.isEncrypted(enc)).toBe(true);
    });
  });

  describe("key rotation", () => {
    it("decrypts ciphertext encrypted with previous key when previous key is configured", () => {
      // Encrypt with old key
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY = OLD_KEY;
      const oldSvc = new CredentialEncryptionService();
      const encryptedWithOldKey = oldSvc.encrypt({ secret: "rotate-me" });

      // New service knows both keys
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT  = VALID_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = OLD_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "v2";
      const newSvc = new CredentialEncryptionService();

      const decrypted = newSvc.decrypt(encryptedWithOldKey as any);
      expect(decrypted).toEqual({ secret: "rotate-me" });
    });

    it("throws when tampered ciphertext and no previous key can recover it", () => {
      const enc = service.encrypt({ x: 1 }) as any;
      enc.tag = "00".repeat(16);
      expect(() => service.decrypt(enc)).toThrow();
    });

    it("throws when ciphertext cannot be decrypted with either key", () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT  = VALID_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = OLD_KEY;
      const svc = new CredentialEncryptionService();

      const totally_different_key = "c".repeat(64);
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT;
      process.env.CREDENTIAL_ENCRYPTION_KEY = totally_different_key;
      const otherSvc = new CredentialEncryptionService();
      const enc = otherSvc.encrypt({ x: 1 });

      expect(() => svc.decrypt(enc as any)).toThrow();
    });

    it("hasPreviousKey is true when CREDENTIAL_ENCRYPTION_KEY_PREVIOUS is set", () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT  = VALID_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = OLD_KEY;
      const svc = new CredentialEncryptionService();
      expect(svc.hasPreviousKey).toBe(true);
    });

    it("hasPreviousKey is false when no previous key is configured", () => {
      expect(service.hasPreviousKey).toBe(false);
    });

    it("isEncryptedWithCurrentKey returns true for current key, false for old key", () => {
      // Encrypt with old key
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY = OLD_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "v1";
      const oldSvc = new CredentialEncryptionService();
      const encOld = oldSvc.encrypt({ x: 1 });

      // New service with key ID v2
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT  = VALID_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = OLD_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "v2";
      const newSvc = new CredentialEncryptionService();
      const encNew = newSvc.encrypt({ x: 1 });

      expect(newSvc.isEncryptedWithCurrentKey(encNew)).toBe(true);
      expect(newSvc.isEncryptedWithCurrentKey(encOld)).toBe(false);
    });
  });

  describe("countPlaintext / countCurrentKey / countOldKey", () => {
    it("counts credentials that are not encrypted", () => {
      const enc = service.encrypt({ k: "v" });
      const plain = { accessToken: "tok" };
      expect(service.countPlaintext([enc, plain, enc, plain, plain])).toBe(3);
    });

    it("returns 0 when all are encrypted", () => {
      const enc = service.encrypt({ k: "v" });
      expect(service.countPlaintext([enc, enc])).toBe(0);
    });

    it("countCurrentKey returns count of envelopes with matching kid", () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT  = VALID_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = OLD_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "v2";
      const svc = new CredentialEncryptionService();

      // Encrypt with old key (kid=v1)
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT;
      process.env.CREDENTIAL_ENCRYPTION_KEY = OLD_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "v1";
      const oldSvc = new CredentialEncryptionService();
      const encOld = oldSvc.encrypt({ x: 1 });

      const encNew = svc.encrypt({ x: 2 });
      const plain = { x: 3 };

      expect(svc.countCurrentKey([encNew, encOld, plain])).toBe(1);
      expect(svc.countOldKey([encNew, encOld, plain])).toBe(1);
      expect(svc.countPlaintext([encNew, encOld, plain])).toBe(1);
    });
  });
});
