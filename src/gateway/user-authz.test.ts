import { describe, expect, it } from "vitest";
import { authorizeAndRewriteUserMethod } from "./user-authz.js";

function baseClient() {
  return {
    connect: {
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      client: { id: "openclaw-control-ui", mode: "webchat", version: "test" },
      minProtocol: 3,
      maxProtocol: 3,
    },
    authUser: {
      username: "alice",
      role: "user" as const,
      agentId: "agent-a",
      mainSessionKey: "home",
      allowedChannels: [{ channel: "telegram", accountId: "acct-1" }],
    },
  } as unknown as Parameters<typeof authorizeAndRewriteUserMethod>[0]["client"];
}

describe("authorizeAndRewriteUserMethod", () => {
  it("blocks admin methods for user role", () => {
    const outcome = authorizeAndRewriteUserMethod({
      req: { type: "req", id: "1", method: "config.apply", params: {} },
      client: baseClient(),
    });
    expect(outcome.ok).toBe(false);
  });

  it("rewrites session-scoped methods to the user's main session", () => {
    const outcome = authorizeAndRewriteUserMethod({
      req: { type: "req", id: "1", method: "chat.send", params: { message: "hello" } },
      client: baseClient(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect((outcome.req.params as { sessionKey?: string }).sessionKey).toBe("agent:agent-a:home");
    expect((outcome.req.params as { agentId?: string }).agentId).toBeUndefined();
  });

  it("filters agents.list payload to only the user's agent", () => {
    const outcome = authorizeAndRewriteUserMethod({
      req: { type: "req", id: "1", method: "agents.list", params: {} },
      client: baseClient(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const filtered = outcome.filterPayload("agents.list", {
      defaultId: "main",
      agents: [
        { id: "agent-a", name: "A" },
        { id: "agent-b", name: "B" },
      ],
      count: 2,
    }) as { defaultId: string; agents: Array<{ id: string }>; count: number };
    expect(filtered.defaultId).toBe("agent-a");
    expect(filtered.agents.map((agent) => agent.id)).toEqual(["agent-a"]);
    expect(filtered.count).toBe(1);
  });
});
