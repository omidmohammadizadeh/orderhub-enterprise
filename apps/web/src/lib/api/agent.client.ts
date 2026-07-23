import { apiClient } from "./client";

export interface AgentTurn {
  role: "user" | "assistant";
  text: string;
}

export const agentClient = {
  status: () =>
    apiClient
      .get<{ configured: boolean }>("/v1/agent/status")
      .then((r) => r.data),

  // Send the full conversation so far (last item = new user message). The
  // server runs the read-only tool loop and returns the assistant reply.
  chat: (messages: AgentTurn[]) =>
    apiClient
      .post<{ reply: string; toolsUsed: string[] }>("/v1/agent/chat", {
        messages,
      })
      .then((r) => r.data),
};
