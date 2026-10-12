import { Injectable, Logger } from "@nestjs/common";
import { createSign } from "crypto";
import { safeColor } from "./pass-art";
import type { PassView } from "./pass-view";
import { scanValue } from "./walk-in-codes";

// Google Wallet loyalty pass for the walk-in card.
//
// ── Setup (one-off) ──────────────────────────────────────────────────────────
//  1. pay.google.com/business/console → Google Wallet API → note the Issuer ID
//  2. Google Cloud: enable "Google Wallet API", create a service account,
//     download its JSON key, and add the service account's email as a user in
//     the Wallet console (Users → Invite, "Developer").
//  3. Render env:
//       GOOGLE_WALLET_ISSUER_ID               the numeric issuer id
//       GOOGLE_WALLET_SERVICE_ACCOUNT_JSON    the key file (raw JSON or base64)
//  Until Google approves the issuer for publishing, only accounts added as
//  test users in the console can save passes.
//
// ── How it fits together ────────────────────────────────────────────────────
// One loyalty CLASS per shop card (name, logo, colour) and one OBJECT per
// member (stamps, rewards, QR). "Add to Google Wallet" is a signed JWT that
// carries both, so nothing has to exist at Google before the customer taps
// it. After that, a stamp PATCHes the object and the phone updates itself.

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const API = "https://walletobjects.googleapis.com/walletobjects/v1";

function b64url(v: string | Buffer): string {
  return Buffer.from(v).toString("base64url");
}

@Injectable()
export class GoogleWalletService {
  private readonly logger = new Logger(GoogleWalletService.name);
  private account: ServiceAccount | null = null;
  private token: { value: string; expiresAt: number } | null = null;

  configured(): boolean {
    return Boolean(process.env.GOOGLE_WALLET_ISSUER_ID && process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON);
  }

  private get issuer(): string {
    return process.env.GOOGLE_WALLET_ISSUER_ID ?? "";
  }

  classId(cardId: string): string {
    return `${this.issuer}.ohcard_${cardId}`;
  }

  objectId(memberId: string): string {
    return `${this.issuer}.ohmember_${memberId}`;
  }

  /** The "Add to Google Wallet" link. */
  saveUrl(view: PassView): string {
    const sa = this.loadAccount();
    const now = Math.floor(Date.now() / 1000);
    const web = (process.env.WEB_URL ?? "https://www.orderhubsolutions.com").replace(/\/+$/, "");
    const jwt = this.signJwt(
      {
        iss: sa.client_email,
        aud: "google",
        typ: "savetowallet",
        iat: now,
        origins: [web],
        payload: {
          loyaltyClasses: [this.buildClass(view)],
          loyaltyObjects: [this.buildObject(view)],
        },
      },
      sa.private_key,
    );
    return `https://pay.google.com/gp/v/save/${jwt}`;
  }

  /** Push the member's new stamps/rewards to the saved pass. */
  async updateObject(view: PassView): Promise<void> {
    if (!this.configured()) return;
    const res = await this.call("PATCH", `/loyaltyObject/${encodeURIComponent(this.objectId(view.memberId))}`, this.buildObject(view));
    // 404: the customer never actually saved it. Nothing to update.
    if (!res.ok && res.status !== 404) {
      this.logger.warn(`Google Wallet object update ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }

  /** The shop changed its card's name, colour or logo. */
  async updateClass(view: PassView): Promise<void> {
    if (!this.configured()) return;
    const res = await this.call("PUT", `/loyaltyClass/${encodeURIComponent(this.classId(view.cardId))}`, this.buildClass(view));
    if (!res.ok && res.status !== 404) {
      this.logger.warn(`Google Wallet class update ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }

  private buildClass(view: PassView) {
    return {
      id: this.classId(view.cardId),
      issuerName: view.title.slice(0, 20) || "Loyalty",
      programName: `${view.title} Rewards`.slice(0, 40),
      programLogo: {
        sourceUri: { uri: view.iconUrl },
        contentDescription: { defaultValue: { language: "en-GB", value: view.title } },
      },
      hexBackgroundColor: safeColor(view.color),
      reviewStatus: "UNDER_REVIEW",
      multipleDevicesAndHoldersAllowedStatus: "ONE_USER_ALL_DEVICES",
    };
  }

  private buildObject(view: PassView) {
    return {
      id: this.objectId(view.memberId),
      classId: this.classId(view.cardId),
      state: "ACTIVE",
      accountId: view.code,
      accountName: view.firstName || "Member",
      hexBackgroundColor: safeColor(view.color),
      barcode: { type: "QR_CODE", value: scanValue(view.code), alternateText: view.code },
      loyaltyPoints: {
        label: "Stamps",
        balance: { string: `${view.stamps} of ${view.stampsRequired}` },
      },
      secondaryLoyaltyPoints: {
        label: view.rewardsReady > 0 ? "Ready to claim" : "Rewards",
        balance: { int: view.rewardsReady },
      },
      imageModulesData: [
        {
          id: "stamps",
          mainImage: {
            sourceUri: { uri: view.stripUrl },
            contentDescription: {
              defaultValue: { language: "en-GB", value: `${view.stamps} of ${view.stampsRequired} stamps` },
            },
          },
        },
      ],
      textModulesData: [
        { id: "reward", header: "Reward", body: view.rewardLabel },
        { id: "how", header: "How it works", body: `${view.earnRule} Show this card at the till when you pay.` },
        ...(view.expiryNote ? [{ id: "expiry", header: "Rewards", body: view.expiryNote }] : []),
      ],
      linksModuleData: {
        uris: [{ id: "card", uri: view.cardUrl, description: "Open your card" }],
      },
    };
  }

  private async call(method: string, path: string, body: unknown): Promise<Response> {
    const token = await this.accessToken();
    return fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const sa = this.loadAccount();
    const now = Math.floor(Date.now() / 1000);
    const assertion = this.signJwt(
      {
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/wallet_object.issuer",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      },
      sa.private_key,
    );
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    if (!res.ok) throw new Error(`Google token ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  private signJwt(claims: Record<string, unknown>, privateKey: string): string {
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = b64url(JSON.stringify(claims));
    const signer = createSign("RSA-SHA256");
    signer.update(`${head}.${body}`);
    return `${head}.${body}.${signer.sign(privateKey).toString("base64url")}`;
  }

  private loadAccount(): ServiceAccount {
    if (this.account) return this.account;
    const raw = (process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON ?? "").trim();
    if (!raw) throw new Error("Google Wallet is not set up");
    const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(text) as ServiceAccount;
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    this.account = parsed;
    return parsed;
  }
}
