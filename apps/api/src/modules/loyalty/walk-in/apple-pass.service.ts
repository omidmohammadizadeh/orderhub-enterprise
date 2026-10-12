import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import * as http2 from "http2";
import * as forge from "node-forge";
import { fetchImage, foregroundFor, renderIcon, renderPassLogo, renderStampStrip, rgb, safeColor } from "./pass-art";
import type { PassView } from "./pass-view";
import { scanValue } from "./walk-in-codes";
import { zipStore } from "./zip";

// Apple Wallet (.pkpass) for the walk-in card.
//
// ── Setup (one-off, in the Apple Developer account) ──────────────────────────
//  1. Identifiers → Pass Type IDs → register e.g. pass.com.orderhubsolutions.loyalty
//  2. Create its certificate, open it in Keychain, export cert + key as .p12
//  3. Render env:
//       APPLE_PASS_TYPE_ID      pass.com.orderhubsolutions.loyalty
//       APPLE_TEAM_ID           the 10-character team id
//       APPLE_PASS_P12_BASE64   base64 of the .p12
//       APPLE_PASS_P12_PASSWORD the export password (may be empty)
//     (or APPLE_PASS_CERT_PEM + APPLE_PASS_KEY_PEM instead of the .p12)
//  Apple's WWDR G4 intermediate is fetched from apple.com on first use;
//  APPLE_WWDR_CERT_PEM overrides that.
//
// ── Why the pass updates by itself ──────────────────────────────────────────
// webServiceURL + authenticationToken make the iPhone register with us
// (PassKitController). When a stamp lands we push an empty notification to
// APNs with the pass certificate; the phone then asks for the newer pass and
// shows the field's changeMessage on the lock screen ("Stamp added — 4 of 6").

const WWDR_URL = "https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer";

interface Creds {
  cert: forge.pki.Certificate;
  key: forge.pki.PrivateKey;
  certPem: string;
  keyPem: string;
}

/** forge types its OID table as possibly-undefined; these all exist. */
const oid = (name: string): string => forge.pki.oids[name] as string;

const pem = (v: string | undefined) => (v ? v.replace(/\\n/g, "\n") : undefined);

@Injectable()
export class ApplePassService {
  private readonly logger = new Logger(ApplePassService.name);
  private creds: Creds | null = null;
  private wwdr: forge.pki.Certificate | null = null;

  get passTypeId(): string {
    return process.env.APPLE_PASS_TYPE_ID ?? "";
  }

  configured(): boolean {
    return Boolean(
      process.env.APPLE_PASS_TYPE_ID &&
        process.env.APPLE_TEAM_ID &&
        (process.env.APPLE_PASS_P12_BASE64 ||
          (process.env.APPLE_PASS_CERT_PEM && process.env.APPLE_PASS_KEY_PEM)),
    );
  }

  /** Where the iPhone talks to us about this pass. */
  webServiceUrl(): string {
    const api = (process.env.API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
    return `${api}/api/v1/loyalty/passkit`;
  }

  async build(view: PassView): Promise<Buffer> {
    const creds = this.loadCreds();
    const wwdr = await this.loadWwdr();

    const bg = safeColor(view.color);
    const fg = foregroundFor(bg);
    const ready = view.rewardsReady > 0;

    const pass = {
      formatVersion: 1,
      passTypeIdentifier: this.passTypeId,
      serialNumber: view.memberId,
      teamIdentifier: process.env.APPLE_TEAM_ID,
      organizationName: view.title,
      description: `${view.title} loyalty card`,
      logoText: view.title,
      backgroundColor: rgb(bg),
      foregroundColor: rgb(fg),
      labelColor: rgb(fg),
      sharingProhibited: true,
      webServiceURL: this.webServiceUrl(),
      authenticationToken: view.publicToken,
      barcodes: [
        {
          format: "PKBarcodeFormatQR",
          message: scanValue(view.code),
          messageEncoding: "iso-8859-1",
          altText: view.code,
        },
      ],
      storeCard: {
        headerFields: [
          {
            key: "rewards",
            label: "REWARDS",
            value: view.rewardsReady,
            changeMessage: "You have %@ reward ready to claim 🎉",
          },
        ],
        secondaryFields: [
          {
            key: "stamps",
            label: "STAMPS",
            value: `${view.stamps} of ${view.stampsRequired}`,
            changeMessage: "Stamp added — %@",
          },
          {
            key: "reward",
            label: ready ? "READY TO CLAIM" : "REWARD",
            value: view.rewardLabel,
            textAlignment: "PKTextAlignmentRight",
          },
        ],
        auxiliaryFields: view.firstName
          ? [{ key: "member", label: "MEMBER", value: view.firstName }]
          : [],
        backFields: [
          { key: "how", label: "How it works", value: `${view.earnRule} Show this card at the till when you pay.` },
          ...(view.expiryNote ? [{ key: "expiry", label: "Rewards", value: view.expiryNote }] : []),
          {
            key: "card",
            label: "Your card online",
            value: view.cardUrl,
            attributedValue: `<a href="${view.cardUrl}">Open your card</a>`,
          },
          { key: "number", label: "Card number", value: view.code },
        ],
      },
    };

    const logo = await fetchImage(view.logoUrl);
    const files: Array<{ name: string; data: Buffer }> = [
      { name: "pass.json", data: Buffer.from(JSON.stringify(pass)) },
      { name: "icon.png", data: await renderIcon(logo, bg, 29) },
      { name: "icon@2x.png", data: await renderIcon(logo, bg, 58) },
      { name: "icon@3x.png", data: await renderIcon(logo, bg, 87) },
      { name: "strip.png", data: await renderStampStrip(view.stamps, view.stampsRequired, bg, 1) },
      { name: "strip@2x.png", data: await renderStampStrip(view.stamps, view.stampsRequired, bg, 2) },
      { name: "strip@3x.png", data: await renderStampStrip(view.stamps, view.stampsRequired, bg, 3) },
    ];
    if (logo) {
      files.push(
        { name: "logo.png", data: await renderPassLogo(logo, 1) },
        { name: "logo@2x.png", data: await renderPassLogo(logo, 2) },
        { name: "logo@3x.png", data: await renderPassLogo(logo, 3) },
      );
    }

    const manifest: Record<string, string> = {};
    for (const f of files) manifest[f.name] = createHash("sha1").update(f.data).digest("hex");
    const manifestBuf = Buffer.from(JSON.stringify(manifest));

    files.push({ name: "manifest.json", data: manifestBuf });
    files.push({ name: "signature", data: this.sign(manifestBuf, creds, wwdr) });
    return zipStore(files);
  }

  /**
   * Tell every iPhone holding these passes that something changed. Returns
   * the push tokens Apple says are gone (410), so the caller can forget them.
   */
  async push(pushTokens: string[]): Promise<string[]> {
    if (!pushTokens.length || !this.configured()) return [];
    const creds = this.loadCreds();
    const dead: string[] = [];
    const client = http2.connect("https://api.push.apple.com", {
      cert: creds.certPem,
      key: creds.keyPem,
    });
    client.on("error", (err) => this.logger.warn(`APNs connection: ${err.message}`));
    try {
      await Promise.all(
        pushTokens.map(
          (token) =>
            new Promise<void>((resolve) => {
              const req = client.request({
                ":method": "POST",
                ":path": `/3/device/${token}`,
                "apns-topic": this.passTypeId,
              });
              req.setTimeout(10_000, () => {
                req.close();
                resolve();
              });
              req.on("response", (headers) => {
                const status = Number(headers[":status"]);
                if (status === 410) dead.push(token);
                else if (status !== 200) this.logger.warn(`APNs ${status} for a loyalty pass`);
              });
              req.on("error", () => resolve());
              req.on("close", () => resolve());
              req.end("{}");
            }),
        ),
      );
    } finally {
      client.close();
    }
    return dead;
  }

  private sign(manifest: Buffer, creds: Creds, wwdr: forge.pki.Certificate): Buffer {
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(manifest.toString("binary"));
    p7.addCertificate(creds.cert);
    p7.addCertificate(wwdr);
    p7.addSigner({
      key: creds.key as forge.pki.rsa.PrivateKey,
      certificate: creds.cert,
      digestAlgorithm: oid("sha256"),
      authenticatedAttributes: [
        { type: oid("contentType"), value: oid("data") },
        { type: oid("messageDigest") },
        // forge's typings say string; it wants a Date here.
        { type: oid("signingTime"), value: new Date() as unknown as string },
      ],
    });
    p7.sign({ detached: true });
    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), "binary");
  }

  private loadCreds(): Creds {
    if (this.creds) return this.creds;
    if (!this.configured()) throw new Error("Apple Wallet is not set up");

    let cert: forge.pki.Certificate;
    let key: forge.pki.PrivateKey;
    if (process.env.APPLE_PASS_P12_BASE64) {
      const der = Buffer.from(process.env.APPLE_PASS_P12_BASE64, "base64").toString("binary");
      const p12 = forge.pkcs12.pkcs12FromAsn1(
        forge.asn1.fromDer(der),
        process.env.APPLE_PASS_P12_PASSWORD ?? "",
      );
      const certBag = p12.getBags({ bagType: oid("certBag") })[oid("certBag")]?.find(
        (b: forge.pkcs12.Bag) => b.cert,
      );
      const keyBag =
        p12.getBags({ bagType: oid("pkcs8ShroudedKeyBag") })[oid("pkcs8ShroudedKeyBag")]?.[0] ??
        p12.getBags({ bagType: oid("keyBag") })[oid("keyBag")]?.[0];
      if (!certBag?.cert || !keyBag?.key) throw new Error("APPLE_PASS_P12_BASE64 has no certificate and key");
      cert = certBag.cert;
      key = keyBag.key;
    } else {
      cert = forge.pki.certificateFromPem(pem(process.env.APPLE_PASS_CERT_PEM)!);
      const keyPem = pem(process.env.APPLE_PASS_KEY_PEM)!;
      key = process.env.APPLE_PASS_KEY_PASSPHRASE
        ? forge.pki.decryptRsaPrivateKey(keyPem, process.env.APPLE_PASS_KEY_PASSPHRASE)
        : forge.pki.privateKeyFromPem(keyPem);
      if (!key) throw new Error("APPLE_PASS_KEY_PEM could not be read");
    }

    this.creds = {
      cert,
      key,
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(key as forge.pki.rsa.PrivateKey),
    };
    return this.creds;
  }

  private async loadWwdr(): Promise<forge.pki.Certificate> {
    if (this.wwdr) return this.wwdr;
    const fromEnv = pem(process.env.APPLE_WWDR_CERT_PEM);
    if (fromEnv) {
      this.wwdr = forge.pki.certificateFromPem(fromEnv);
      return this.wwdr;
    }
    const res = await fetch(WWDR_URL);
    if (!res.ok) throw new Error(`Could not fetch Apple WWDR certificate (${res.status})`);
    const der = Buffer.from(await res.arrayBuffer()).toString("binary");
    this.wwdr = forge.pki.certificateFromAsn1(forge.asn1.fromDer(der));
    return this.wwdr;
  }
}
