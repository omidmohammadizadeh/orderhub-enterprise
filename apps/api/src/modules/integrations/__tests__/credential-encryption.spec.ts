import { CredentialEncryptionService } from "../credential-encryption.service";

describe("CredentialEncryptionService", () => {
  const VALID_KEY = "a".repeat(64); // 32 bytes as hex
  let service: CredentialEncryptionService;

  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = VALID_KEY;
    service = new CredentialEncryptionService();
  });

  afterEach(() => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
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

    it("includes v, alg, iv, tag, ct in the envelope", () => {
      const encrypted = service.encrypt({ key: "value" }) as any;
      expect(encrypted.v).toBe(1);
      expect(encrypted.alg).toBe("aes-256-gcm");
      expect(typeof encrypted.iv).toBe("string");
      expect(typeof encrypted.tag).toBe("string");
      expect(typeof encrypted.ct).toBe("string");
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
      encrypted.ct = "deadbeef" + encrypted.ct.slice(8); // corrupt ciphertext

      expect(() => service.decrypt(encrypted)).toThrow();
    });

    it("throws when auth tag is tampered", () => {
      const encrypted = service.encrypt({ secret: "value" }) as any;
      encrypted.tag = "00".repeat(16); // zero out the tag

      expect(() => service.decrypt(encrypted)).toThrow();
    });
  });

  describe("missing key handling", () => {
    it("in dev mode (non-production) with no key, encrypt is a passthrough", () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      const noKeySvc = new CredentialEncryptionService();
      const creds = { accessToken: "tok" };
      const result = noKeySvc.encrypt(creds as any);
      expect(result).toEqual(creds); // passthrough
    });

    it("in production mode, throws if key is missing", () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        expect(() => new CredentialEncryptionService()).toThrow(
          "CREDENTIAL_ENCRYPTION_KEY must be set in production",
        );
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it("throws if key length is wrong", () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY = "tooshort";
      expect(() => new CredentialEncryptionService()).toThrow("64 hex characters");
    });
  });

  describe("countPlaintext", () => {
    it("counts credentials that are not encrypted", () => {
      const enc = service.encrypt({ k: "v" });
      const plain = { accessToken: "tok" };
      expect(service.countPlaintext([enc, plain, enc, plain, plain])).toBe(3);
    });

    it("returns 0 when all are encrypted", () => {
      const enc = service.encrypt({ k: "v" });
      expect(service.countPlaintext([enc, enc])).toBe(0);
    });
  });
});
