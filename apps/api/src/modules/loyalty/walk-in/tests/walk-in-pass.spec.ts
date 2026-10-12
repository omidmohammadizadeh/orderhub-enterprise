import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as forge from "node-forge";
import sharp from "sharp";
import { ApplePassService } from "../apple-pass.service";
import { GoogleWalletService } from "../google-wallet.service";
import { renderStampStrip } from "../pass-art";
import type { PassView } from "../pass-view";
import { newMemberCode, parseMemberCode, scanValue } from "../walk-in-codes";
import { crc32 } from "../zip";

// The wallet passes are built and signed by hand (no passkit library), so
// these build real ones with a throwaway certificate and open them again.

function selfSigned(cn: string, issuer?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey }) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Math.floor(Math.random() * 1e9));
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  cert.setSubject([{ name: "commonName", value: cn }]);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : [{ name: "commonName", value: cn }]);
  cert.sign(issuer ? issuer.key : keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

const VIEW: PassView = {
  memberId: "mem_1",
  cardId: "card_1",
  code: "ABCD2345",
  publicToken: "x".repeat(32),
  firstName: "Sam",
  title: "2 Brothers",
  color: "#6B3E26",
  logoUrl: null,
  stamps: 4,
  stampsRequired: 6,
  rewardsReady: 1,
  rewardLabel: "Free coffee",
  earnRule: "Every order earns a stamp. Collect 6 for free coffee.",
  expiryNote: null,
  cardUrl: "https://www.orderhubsolutions.com/loyalty/card/xxx",
  stripUrl: "https://api.example/strip.png",
  iconUrl: "https://api.example/icon.png",
  updatedAt: new Date(),
};

describe("walk-in card codes", () => {
  it("reads back what the QR carries, typed or scanned", () => {
    const code = newMemberCode();
    expect(code).toMatch(/^[2-9A-Z]{8}$/);
    expect(parseMemberCode(scanValue(code))).toBe(code);
    expect(parseMemberCode(scanValue(code).toLowerCase())).toBe(code);
    expect(parseMemberCode(`OHL;${code}`)).toBe(code); // non-UK scanner layout
    expect(parseMemberCode("abcd 2345")).toBe("ABCD2345");
    expect(parseMemberCode("5012345678900")).toBeNull(); // a product barcode
    expect(parseMemberCode("OHR:123")).toBeNull(); // a returns receipt
  });
});

describe("pass art", () => {
  it("draws the stamp strip at Apple's size", async () => {
    const png = await renderStampStrip(4, 6, "#6B3E26", 2);
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([750, 246]);
  });

  it("copes with a 20-stamp card and a bad colour", async () => {
    const png = await renderStampStrip(25, 20, "not-a-colour", 1);
    expect((await sharp(png).metadata()).width).toBe(375);
  });
});

describe("zip", () => {
  it("matches zlib's CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("Apple Wallet pass", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("is a signed .pkpass that unzips with a manifest covering every file", async () => {
    const wwdr = selfSigned("Test WWDR");
    const pass = selfSigned("Pass Type ID: pass.test.loyalty", { cert: wwdr.cert, key: wwdr.key });
    process.env.APPLE_PASS_TYPE_ID = "pass.test.loyalty";
    process.env.APPLE_TEAM_ID = "TEAM123456";
    process.env.APPLE_PASS_CERT_PEM = forge.pki.certificateToPem(pass.cert);
    process.env.APPLE_PASS_KEY_PEM = forge.pki.privateKeyToPem(pass.key);
    process.env.APPLE_WWDR_CERT_PEM = forge.pki.certificateToPem(wwdr.cert);

    const svc = new ApplePassService();
    expect(svc.configured()).toBe(true);
    const buf = await svc.build(VIEW);

    const dir = mkdtempSync(join(tmpdir(), "pkpass-"));
    const file = join(dir, "card.pkpass");
    writeFileSync(file, buf);
    const listing = execFileSync("unzip", ["-l", file]).toString();
    for (const name of ["pass.json", "manifest.json", "signature", "icon.png", "strip@2x.png"]) {
      expect(listing).toContain(name);
    }
    execFileSync("unzip", ["-q", file, "-d", dir]);
    const passJson = JSON.parse(execFileSync("cat", [join(dir, "pass.json")]).toString());
    expect(passJson.barcodes[0].message).toBe("OHL:ABCD2345");
    expect(passJson.storeCard.secondaryFields[0].value).toBe("4 of 6");
    expect(passJson.authenticationToken).toBe(VIEW.publicToken);

    // The signature is a detached PKCS#7 over manifest.json by the pass cert.
    const manifest = execFileSync("cat", [join(dir, "manifest.json")]);
    const sig = execFileSync("cat", [join(dir, "signature")]);
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(sig.toString("binary"))) as any;
    expect(p7.certificates).toHaveLength(2);
    const digest = forge.md.sha256.create().update(manifest.toString("binary")).digest().getBytes();
    const attrs = p7.rawCapture.authenticatedAttributes as any[];
    const md = attrs
      .map((a: any) => forge.asn1.derToOid(a.value[0].value))
      .indexOf("1.2.840.113549.1.9.4");
    expect(attrs[md].value[1].value[0].value).toBe(digest);
  });
});

describe("Google Wallet link", () => {
  it("is a JWT carrying the class and the member's object", () => {
    const { privateKey } = forge.pki.rsa.generateKeyPair(1024);
    process.env.GOOGLE_WALLET_ISSUER_ID = "3388000000012345678";
    process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: "wallet@test.iam.gserviceaccount.com",
      private_key: forge.pki.privateKeyToPem(privateKey),
    });
    const url = new GoogleWalletService().saveUrl(VIEW);
    expect(url).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    const claims = JSON.parse(Buffer.from(url.split("/").pop()!.split(".")[1]!, "base64url").toString());
    expect(claims.typ).toBe("savetowallet");
    const obj = claims.payload.loyaltyObjects[0];
    expect(obj.id).toBe("3388000000012345678.ohmember_mem_1");
    expect(obj.barcode.value).toBe("OHL:ABCD2345");
    expect(obj.loyaltyPoints.balance.string).toBe("4 of 6");
    expect(claims.payload.loyaltyClasses[0].id).toBe(obj.classId);
  });
});

