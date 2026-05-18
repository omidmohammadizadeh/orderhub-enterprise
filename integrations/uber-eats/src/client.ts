import axios, { AxiosInstance } from "axios";

interface UberEatsCredentials {
  clientId: string;
  clientSecret: string;
  storeId: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

// Uber Eats REST client with automatic OAuth token management.
// Each location has its own credentials stored (encrypted) in the DB;
// this client is instantiated per request with the decrypted credentials.
export class UberEatsClient {
  private readonly http: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(
    private readonly credentials: UberEatsCredentials,
    private readonly baseUrl = process.env.UBER_EATS_BASE_URL ?? "https://api.uber.com/v2",
  ) {
    this.http = axios.create({ baseURL: this.baseUrl });
  }

  private async ensureToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 30_000) {
      return;
    }
    const response = await axios.post<TokenResponse>(
      "https://login.uber.com/oauth/v2/token",
      new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        grant_type: "client_credentials",
        scope: "eats.store eats.order",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    this.accessToken = response.data.access_token;
    this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
  }

  async acceptOrder(orderId: string) {
    await this.ensureToken();
    return this.http.post(
      `/eats/orders/${orderId}/accept_pos_order`,
      {},
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
    );
  }

  async denyOrder(orderId: string, reason: string) {
    await this.ensureToken();
    return this.http.post(
      `/eats/orders/${orderId}/deny_pos_order`,
      { reason },
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
    );
  }

  async updateOrderStatus(orderId: string, status: string) {
    await this.ensureToken();
    return this.http.post(
      `/eats/orders/${orderId}/cancel`,
      { reason: status },
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
    );
  }

  async getStoreStatus() {
    await this.ensureToken();
    return this.http.get(`/eats/stores/${this.credentials.storeId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
  }
}
