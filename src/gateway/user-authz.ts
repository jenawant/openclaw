import {
  buildAgentMainSessionKey,
  normalizeAccountId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import type { ControlUiViewer } from "./control-ui-auth.js";
import { ErrorCodes, errorShape, type RequestFrame } from "./protocol/index.js";
import type { GatewayClient } from "./server-methods/types.js";

type AuthzOutcome =
  | {
      ok: true;
      req: RequestFrame;
      filterPayload: (method: string, payload: unknown) => unknown;
    }
  | { ok: false; error: ReturnType<typeof errorShape> };

const USER_BLOCKED_METHODS = new Set<string>([
  "channels.logout",
  "config.apply",
  "config.patch",
  "device.pair.approve",
  "device.pair.list",
  "device.pair.reject",
  "device.pair.remove",
  "device.token.revoke",
  "device.token.rotate",
  "update.run",
  "secrets.reload",
  "secrets.resolve",
  "skills.install",
  "skills.update",
  "agents.create",
  "agents.update",
  "agents.delete",
]);

const USER_BLOCKED_PREFIXES = [
  "debug.",
  "logs.",
  "node.",
  "nodes.",
  "exec.approval.",
  "voicewake.",
  "tts.",
  "push.",
  "doctor.",
];

const SESSION_SCOPED_METHODS = new Set<string>([
  "chat.abort",
  "chat.history",
  "chat.send",
  "poll",
  "send",
  "agent",
  "agent.wait",
]);

const AGENT_SCOPED_METHOD_PREFIXES = [
  "agent.",
  "agents.files.",
  "agents.models.",
  "skills.status",
  "tools.catalog",
  "sessions.",
  "cron.",
];

const AGENT_SCOPED_METHODS = new Set<string>(["agent", "send", "poll"]);

function isMethodBlockedForUser(method: string): boolean {
  if (USER_BLOCKED_METHODS.has(method)) {
    return true;
  }
  return USER_BLOCKED_PREFIXES.some((prefix) => method.startsWith(prefix));
}

function methodSupportsAgentId(method: string): boolean {
  if (AGENT_SCOPED_METHODS.has(method)) {
    return true;
  }
  return AGENT_SCOPED_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

function normalizeViewer(viewer: ControlUiViewer): ControlUiViewer {
  return {
    username: viewer.username,
    role: viewer.role,
    agentId: viewer.agentId.trim().toLowerCase(),
    mainSessionKey: (viewer.mainSessionKey ?? "").trim() || "main",
    allowedChannels: Array.isArray(viewer.allowedChannels)
      ? viewer.allowedChannels
          .map((entry) => ({
            channel: entry.channel.trim().toLowerCase(),
            accountId: entry.accountId?.trim() || undefined,
          }))
          .filter((entry) => entry.channel.length > 0)
      : [],
  };
}

function sessionKeyAgentId(sessionKey: string): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.agentId) {
    return null;
  }
  return parsed.agentId.trim().toLowerCase();
}

function normalizeParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object") {
    return {};
  }
  return { ...(params as Record<string, unknown>) };
}

function isChannelAllowed(
  viewer: ControlUiViewer,
  channelRaw: unknown,
  accountIdRaw: unknown,
): boolean {
  if (typeof channelRaw !== "string" || !channelRaw.trim()) {
    return true;
  }
  const channel = channelRaw.trim().toLowerCase();
  const accountId =
    typeof accountIdRaw === "string" && accountIdRaw.trim()
      ? normalizeAccountId(accountIdRaw)
      : undefined;
  return viewer.allowedChannels.some((entry) => {
    if (entry.channel !== channel) {
      return false;
    }
    if (!entry.accountId) {
      return true;
    }
    return normalizeAccountId(entry.accountId) === accountId;
  });
}

function filterSessionsListPayload(viewer: ControlUiViewer, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const src = payload as {
    sessions?: Array<Record<string, unknown>>;
    count?: number;
  };
  if (!Array.isArray(src.sessions)) {
    return payload;
  }
  const sessions = src.sessions.filter((entry) => {
    const agentId =
      typeof entry.agentId === "string" && entry.agentId.trim()
        ? entry.agentId.trim().toLowerCase()
        : typeof entry.sessionKey === "string"
          ? sessionKeyAgentId(entry.sessionKey)
          : null;
    return agentId === viewer.agentId;
  });
  return {
    ...src,
    sessions,
    count: sessions.length,
  };
}

function filterChannelsStatusPayload(viewer: ControlUiViewer, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const src = payload as {
    channelAccounts?: Record<string, Array<Record<string, unknown>>>;
    channelDefaultAccountId?: Record<string, string>;
    channelOrder?: string[];
    channels?: Record<string, unknown>;
  };
  if (!src.channelAccounts || typeof src.channelAccounts !== "object") {
    return payload;
  }
  const allowedChannels = new Set(viewer.allowedChannels.map((entry) => entry.channel));
  const channelAccounts: Record<string, Array<Record<string, unknown>>> = {};
  for (const [channelRaw, accountsRaw] of Object.entries(src.channelAccounts)) {
    const channel = channelRaw.trim().toLowerCase();
    if (!allowedChannels.has(channel)) {
      continue;
    }
    const accounts = Array.isArray(accountsRaw) ? accountsRaw : [];
    channelAccounts[channelRaw] = accounts.filter((entry) =>
      isChannelAllowed(viewer, channel, entry.accountId),
    );
  }
  const channelDefaultAccountId: Record<string, string> = {};
  for (const [channel, accountId] of Object.entries(src.channelDefaultAccountId ?? {})) {
    if (isChannelAllowed(viewer, channel, accountId)) {
      channelDefaultAccountId[channel] = accountId;
    }
  }
  const channels: Record<string, unknown> = {};
  for (const [channel, value] of Object.entries(src.channels ?? {})) {
    if (allowedChannels.has(channel.trim().toLowerCase())) {
      channels[channel] = value;
    }
  }
  const channelOrder = (src.channelOrder ?? []).filter((channel) =>
    allowedChannels.has(channel.trim().toLowerCase()),
  );
  return {
    ...src,
    channelAccounts,
    channelDefaultAccountId,
    channels,
    channelOrder,
  };
}

function filterAgentsListPayload(viewer: ControlUiViewer, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const src = payload as {
    defaultId?: string;
    agents?: Array<Record<string, unknown>>;
    count?: number;
  };
  if (!Array.isArray(src.agents)) {
    return payload;
  }
  const agents = src.agents.filter(
    (entry) => typeof entry.id === "string" && entry.id.trim().toLowerCase() === viewer.agentId,
  );
  return {
    ...src,
    defaultId: viewer.agentId,
    agents,
    count: agents.length,
  };
}

function applyResponseFilter(viewer: ControlUiViewer, method: string, payload: unknown): unknown {
  if (method === "sessions.list") {
    return filterSessionsListPayload(viewer, payload);
  }
  if (method === "channels.status") {
    return filterChannelsStatusPayload(viewer, payload);
  }
  if (method === "agents.list") {
    return filterAgentsListPayload(viewer, payload);
  }
  return payload;
}

export function authorizeAndRewriteUserMethod(params: {
  req: RequestFrame;
  client: GatewayClient | null;
}): AuthzOutcome {
  const viewerRaw = params.client?.authUser;
  if (!viewerRaw) {
    return {
      ok: true,
      req: params.req,
      filterPayload: (_method, payload) => payload,
    };
  }
  const viewer = normalizeViewer(viewerRaw);
  if (viewer.role === "admin") {
    return {
      ok: true,
      req: params.req,
      filterPayload: (_method, payload) => payload,
    };
  }

  if (isMethodBlockedForUser(params.req.method)) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `forbidden method for role=user: ${params.req.method}`,
      ),
    };
  }

  const nextReq: RequestFrame = {
    ...params.req,
    params: normalizeParams(params.req.params),
  };
  const nextParams = nextReq.params as Record<string, unknown>;

  if (typeof nextParams.agentId === "string" && nextParams.agentId.trim()) {
    if (nextParams.agentId.trim().toLowerCase() !== viewer.agentId) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "forbidden agentId"),
      };
    }
  }
  if (nextParams.agentId == null && methodSupportsAgentId(params.req.method)) {
    nextParams.agentId = viewer.agentId;
  }

  if (typeof nextParams.sessionKey === "string" && nextParams.sessionKey.trim()) {
    const keyAgentId = sessionKeyAgentId(nextParams.sessionKey);
    if (keyAgentId && keyAgentId !== viewer.agentId) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "forbidden sessionKey"),
      };
    }
  }
  if (
    SESSION_SCOPED_METHODS.has(params.req.method) &&
    (typeof nextParams.sessionKey !== "string" || !nextParams.sessionKey.trim())
  ) {
    nextParams.sessionKey = buildAgentMainSessionKey({
      agentId: viewer.agentId,
      mainKey: viewer.mainSessionKey,
    });
  }

  if (!isChannelAllowed(viewer, nextParams.channel, nextParams.accountId)) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "forbidden channel/account binding"),
    };
  }

  return {
    ok: true,
    req: nextReq,
    filterPayload: (method, payload) => applyResponseFilter(viewer, method, payload),
  };
}
