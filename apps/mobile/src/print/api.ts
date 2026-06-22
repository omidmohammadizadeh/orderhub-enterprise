// Thin HTTP client for the /v1/print-agents and /v1/print-jobs endpoints.
// The mobile app talks to the API as a PrintAgent — the same protocol
// the desktop print-bridge uses — so jobs assigned to printers bound
// to this tablet flow into our claim loop.

import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

const API_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  "https://orderhub-api-0re6.onrender.com/api";

const AGENT_KEY = "orderhub.printAgent.v1";

export interface PrintAgentCreds {
  agentId: string;
  apiToken: string;
  locationId: string;
}

export async function loadAgentCreds(): Promise<PrintAgentCreds | null> {
  const raw = await SecureStore.getItemAsync(AGENT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PrintAgentCreds;
  } catch {
    return null;
  }
}

export async function saveAgentCreds(c: PrintAgentCreds): Promise<void> {
  await SecureStore.setItemAsync(AGENT_KEY, JSON.stringify(c));
}

export async function clearAgentCreds(): Promise<void> {
  await SecureStore.deleteItemAsync(AGENT_KEY);
}

// Redeem the 6-char pair code shown in the dashboard's Agents tab.
export async function pair(
  code: string,
  deviceName: string,
  deviceId: string,
): Promise<PrintAgentCreds> {
  const res = await fetch(`${API_URL}/v1/print-agents/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim(), deviceName, deviceId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Pair failed (${res.status}): ${text}`);
  }
  return (await res.json()) as PrintAgentCreds;
}

function headers(creds: PrintAgentCreds) {
  return {
    "Content-Type": "application/json",
    "X-Agent-Token": creds.apiToken,
  };
}

export async function heartbeat(
  creds: PrintAgentCreds,
  body: {
    versionString: string;
    osType: string;
    hostname: string;
    printerCount: number;
    printerStatuses: Array<{ printerId: string; isOnline: boolean }>;
  },
): Promise<boolean> {
  const res = await fetch(
    `${API_URL}/v1/print-agents/${creds.agentId}/heartbeat`,
    {
      method: "POST",
      headers: headers(creds),
      body: JSON.stringify(body),
    },
  );
  return res.ok;
}

export interface ApiPrinter {
  id: string;
  name: string;
  type: string;
  connectionType: string; // LAN | BLUETOOTH | USB
  ipAddress: string | null;
  port: number | null;
  btMac: string | null;
  agentId: string | null;
  paperWidth: number;
  model: string | null;
}

export async function listMyPrinters(
  creds: PrintAgentCreds,
): Promise<ApiPrinter[]> {
  const res = await fetch(
    `${API_URL}/v1/print-agents/${creds.agentId}/printers`,
    { headers: headers(creds) },
  );
  if (!res.ok) return [];
  return (await res.json()) as ApiPrinter[];
}

export async function bindPrinter(
  creds: PrintAgentCreds,
  printerId: string,
): Promise<void> {
  const res = await fetch(
    `${API_URL}/v1/print-agents/${creds.agentId}/bind`,
    {
      method: "POST",
      headers: headers(creds),
      body: JSON.stringify({ printerId }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Bind failed (${res.status}): ${text}`);
  }
}

export interface PrintJob {
  id: string;
  type: string;
  printerId: string | null;
  stationId: string | null;
  status: string;
  payload: any;
  copies: number;
  attempts: number;
}

export async function claimJobs(
  creds: PrintAgentCreds,
  printerIds: string[],
  limit = 5,
): Promise<PrintJob[]> {
  if (printerIds.length === 0) return [];
  const res = await fetch(`${API_URL}/v1/print-jobs/claim`, {
    method: "POST",
    headers: headers(creds),
    body: JSON.stringify({ printerIds, limit }),
  });
  if (!res.ok) return [];
  return (await res.json()) as PrintJob[];
}

export async function completeJob(
  creds: PrintAgentCreds,
  jobId: string,
): Promise<void> {
  await fetch(`${API_URL}/v1/print-jobs/${jobId}/complete`, {
    method: "POST",
    headers: headers(creds),
  });
}

export async function failJob(
  creds: PrintAgentCreds,
  jobId: string,
  failureReason: string,
  lastError: string,
  retryable: boolean,
): Promise<void> {
  await fetch(`${API_URL}/v1/print-jobs/${jobId}/fail`, {
    method: "POST",
    headers: headers(creds),
    body: JSON.stringify({ failureReason, lastError, retryable }),
  });
}
