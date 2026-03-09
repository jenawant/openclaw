import { buildAgentMainSessionKey } from "../../../../src/routing/session-key.js";
import type { ViewerRole } from "../navigation.ts";
import { normalizeBasePath } from "../navigation.ts";

export type AuthViewer = {
  username: string;
  role: ViewerRole;
  agentId: string;
  mainSessionKey: string;
  allowedChannels: Array<{
    channel: string;
    accountId?: string;
  }>;
};

type AuthBootstrapHost = {
  basePath: string;
  authLoading: boolean;
  authEnabled: boolean;
  authViewer: AuthViewer | null;
  authError: string | null;
  authUsername: string;
  authPassword: string;
  settings: import("../storage.ts").UiSettings;
  sessionKey: string;
  applySettings: (next: import("../storage.ts").UiSettings) => void;
  connect: () => void;
  client?: { stop: () => void } | null;
  connected?: boolean;
  tab?: import("../navigation.ts").Tab;
};

function authEndpoint(basePath: string, path: "/me" | "/login" | "/logout"): string {
  const normalizedBasePath = normalizeBasePath(basePath ?? "");
  const prefix = `${normalizedBasePath}/__openclaw__/auth`.replace(/\/{2,}/g, "/");
  return `${prefix}${path}`;
}

function normalizeViewer(payload: unknown): AuthViewer | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as {
    username?: unknown;
    role?: unknown;
    agentId?: unknown;
    mainSessionKey?: unknown;
    allowedChannels?: unknown;
  };
  if (
    typeof candidate.username !== "string" ||
    (candidate.role !== "admin" && candidate.role !== "user") ||
    typeof candidate.agentId !== "string"
  ) {
    return null;
  }
  const allowedChannels = Array.isArray(candidate.allowedChannels)
    ? candidate.allowedChannels
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const raw = entry as { channel?: unknown; accountId?: unknown };
          if (typeof raw.channel !== "string" || !raw.channel.trim()) {
            return null;
          }
          return {
            channel: raw.channel.trim().toLowerCase(),
            accountId:
              typeof raw.accountId === "string" && raw.accountId.trim()
                ? raw.accountId.trim()
                : undefined,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];
  return {
    username: candidate.username.trim(),
    role: candidate.role,
    agentId: candidate.agentId.trim().toLowerCase(),
    mainSessionKey:
      typeof candidate.mainSessionKey === "string" && candidate.mainSessionKey.trim()
        ? candidate.mainSessionKey.trim()
        : "main",
    allowedChannels,
  };
}

function applyViewerDefaults(host: AuthBootstrapHost, viewer: AuthViewer | null) {
  if (!viewer || viewer.role !== "user") {
    return;
  }
  const mainSessionKey = buildAgentMainSessionKey({
    agentId: viewer.agentId,
    mainKey: viewer.mainSessionKey,
  });
  host.sessionKey = mainSessionKey;
  host.applySettings({
    ...host.settings,
    sessionKey: mainSessionKey,
    lastActiveSessionKey: mainSessionKey,
  });
  if (host.tab && host.tab !== "chat") {
    host.tab = "chat";
  }
}

export async function bootstrapAuthAndMaybeConnect(host: AuthBootstrapHost) {
  host.authLoading = true;
  host.authError = null;
  try {
    const meRes = await fetch(authEndpoint(host.basePath, "/me"), {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (meRes.status === 404) {
      host.authEnabled = false;
      host.authViewer = null;
      host.connect();
      return;
    }
    host.authEnabled = true;
    if (meRes.status === 401) {
      host.authViewer = null;
      return;
    }
    if (!meRes.ok) {
      throw new Error(`auth check failed (${meRes.status})`);
    }
    const payload = (await meRes.json()) as { viewer?: unknown };
    const viewer = normalizeViewer(payload.viewer);
    if (!viewer) {
      throw new Error("invalid auth viewer payload");
    }
    host.authViewer = viewer;
    applyViewerDefaults(host, viewer);
    host.connect();
  } catch (error) {
    host.authEnabled = true;
    host.authViewer = null;
    host.authError = String(error);
  } finally {
    host.authLoading = false;
  }
}

export async function loginControlUi(host: AuthBootstrapHost) {
  host.authError = null;
  host.authLoading = true;
  try {
    const username = host.authUsername.trim();
    const password = host.authPassword;
    if (!username || !password) {
      host.authError = "username and password required";
      return;
    }
    const res = await fetch(authEndpoint(host.basePath, "/login"), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      host.authError = body.error || `login failed (${res.status})`;
      return;
    }
    const payload = (await res.json()) as { viewer?: unknown };
    const viewer = normalizeViewer(payload.viewer);
    if (!viewer) {
      host.authError = "invalid login response";
      return;
    }
    host.authViewer = viewer;
    host.authPassword = "";
    applyViewerDefaults(host, viewer);
    host.connect();
  } catch (error) {
    host.authError = String(error);
  } finally {
    host.authLoading = false;
  }
}

export async function logoutControlUi(host: AuthBootstrapHost) {
  host.authError = null;
  host.authLoading = true;
  try {
    await fetch(authEndpoint(host.basePath, "/logout"), {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  } finally {
    host.client?.stop?.();
    host.connected = false;
    host.authViewer = null;
    host.authPassword = "";
    host.authLoading = false;
  }
}
