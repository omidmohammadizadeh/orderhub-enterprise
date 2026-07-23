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
  // server runs the tool loop as a BACKGROUND job (a complex change can take
  // longer than the proxy timeout), so we start it and poll for the reply.
  // Same Promise<{reply, toolsUsed}> shape as before.
  chat: async (messages: AgentTurn[]) => {
    const { jobId } = (
      await apiClient.post<{ jobId: string }>("/v1/agent/chat", { messages })
    ).data;
    const startedAt = Date.now();
    const MAX_WAIT_MS = 5 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        throw new Error("That took too long — try a smaller step.");
      }
      const job = (
        await apiClient.get<{
          status: "pending" | "done" | "failed";
          reply?: string;
          toolsUsed?: string[];
          error?: string;
        }>(`/v1/agent/chat/${jobId}`)
      ).data;
      if (job.status === "done") {
        return { reply: job.reply ?? "", toolsUsed: job.toolsUsed ?? [] };
      }
      if (job.status === "failed") {
        throw new Error(job.error ?? "The assistant hit an error.");
      }
    }
  },
};
