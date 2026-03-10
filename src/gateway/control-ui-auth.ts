import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { applyAgentConfig } from "../commands/agents.config.js";
import { loadConfig, type OpenClawConfig, writeConfigFile } from "../config/config.js";
import type {
  GatewayControlUiAllowedChannel,
  GatewayControlUiLocalAuthConfig,
  GatewayControlUiLocalAuthUser,
} from "../config/types.gateway.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import {
  deleteControlUiAuthDbUser,
  findControlUiAuthDbUser,
  listControlUiAuthDbUsers,
  resolveControlUiAuthDbPathForDisplay,
  upsertControlUiAuthDbUser,
} from "./control-ui-auth-db.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";

const CONTROL_UI_AUTH_PREFIX = "/__openclaw__/auth";
const AUTH_COOKIE_NAME = "openclaw-ui-auth";
const AUTH_COOKIE_MAX_BYTES = 32 * 1024;
const DEFAULT_SESSION_TTL_HOURS = 24;
const SESSION_VERSION = 1;
const LOCALAUTH_ADMIN_USERNAME_ENV = "OPENCLAW_LOCALAUTH_ADMIN_USERNAME";
const LOCALAUTH_ADMIN_PASSWORD_ENV = "OPENCLAW_LOCALAUTH_ADMIN_PASSWORD";
const LOCALAUTH_ADMIN_PASSWORD_HASH_ENV = "OPENCLAW_LOCALAUTH_ADMIN_PASSWORD_HASH";
const LOCALAUTH_ADMIN_AGENT_ID_ENV = "OPENCLAW_LOCALAUTH_ADMIN_AGENT_ID";
const seededAdminDbPaths = new Set<string>();

export type ControlUiViewerRole = "admin" | "user";

export type ControlUiViewer = {
  username: string;
  role: ControlUiViewerRole;
  agentId: string;
  mainSessionKey: string;
  allowedChannels: GatewayControlUiAllowedChannel[];
};

type ControlUiSessionPayload = {
  version: number;
  username: string;
  expMs: number;
  iatMs: number;
};

type ControlUiAuthDeps = {
  nowMs?: () => number;
  verifyPassword?: (password: string, passwordHash: string) => Promise<boolean>;
  hashPassword?: (password: string) => Promise<string>;
};

async function readAuthJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      error: string;
    }
> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (
      value:
        | {
            ok: true;
            value: unknown;
          }
        | {
            ok: false;
            error: string;
          },
    ) => {
      if (done) {
        return;
      }
      done = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        finish({ ok: false, error: "payload too large" });
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (done) {
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        finish({ ok: true, value: {} });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        finish({ ok: false, error: "invalid json payload" });
      }
    });
    req.on("error", () => {
      finish({ ok: false, error: "request read failed" });
    });
  });
}

function normalizeAllowedChannels(
  channels: GatewayControlUiAllowedChannel[] | undefined,
): GatewayControlUiAllowedChannel[] {
  if (!Array.isArray(channels) || channels.length === 0) {
    return [];
  }
  return channels
    .map((entry) => ({
      channel: entry.channel.trim().toLowerCase(),
      accountId: entry.accountId?.trim() || undefined,
    }))
    .filter((entry) => entry.channel.length > 0);
}

function resolveSessionTtlHours(config: GatewayControlUiLocalAuthConfig | undefined): number {
  const raw = config?.sessionTtlHours;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_SESSION_TTL_HOURS;
  }
  return Math.max(1, Math.min(24 * 30, Math.trunc(raw)));
}

function shouldSeedDefaultAdmin(config: GatewayControlUiLocalAuthConfig | undefined): boolean {
  return config?.seedAdminOnEmpty !== false;
}

function resolveSeedAdminUsername(config: GatewayControlUiLocalAuthConfig | undefined): string {
  const fromEnv = process.env[LOCALAUTH_ADMIN_USERNAME_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromConfig = config?.seedAdminUsername?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  return "admin";
}

function resolveSeedAdminAgentId(): string {
  const fromEnv = process.env[LOCALAUTH_ADMIN_AGENT_ID_ENV]?.trim().toLowerCase();
  return fromEnv || "main";
}

function base64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64urlDecode(input: string): string | null {
  try {
    return Buffer.from(input, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function createSessionToken(payload: ControlUiSessionPayload, sessionSecret: string): string {
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", sessionSecret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token: string, sessionSecret: string): ControlUiSessionPayload | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }
  const expectedSignature = createHmac("sha256", sessionSecret)
    .update(encodedPayload)
    .digest("base64url");
  if (!safeEqualSecret(signature, expectedSignature)) {
    return null;
  }
  const decodedPayload = base64urlDecode(encodedPayload);
  if (!decodedPayload) {
    return null;
  }
  try {
    const parsed = JSON.parse(decodedPayload) as ControlUiSessionPayload;
    if (
      !parsed ||
      parsed.version !== SESSION_VERSION ||
      typeof parsed.username !== "string" ||
      typeof parsed.expMs !== "number" ||
      typeof parsed.iatMs !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseCookieHeader(req: IncomingMessage): Map<string, string> {
  const value = req.headers.cookie;
  const header = typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";
  const map = new Map<string, string>();
  if (!header) {
    return map;
  }
  for (const chunk of header.split(";")) {
    const [nameRaw, ...rest] = chunk.split("=");
    const name = nameRaw.trim();
    if (!name) {
      continue;
    }
    const rawValue = rest.join("=").trim();
    map.set(name, rawValue);
  }
  return map;
}

function appendSetCookie(res: ServerResponse, value: string): void {
  const existing =
    typeof (res as { getHeader?: (name: string) => unknown }).getHeader === "function"
      ? (res as { getHeader: (name: string) => unknown }).getHeader("Set-Cookie")
      : undefined;
  if (!existing) {
    res.setHeader("Set-Cookie", value);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, value]);
    return;
  }
  if (typeof existing === "string") {
    res.setHeader("Set-Cookie", [existing, value]);
    return;
  }
  res.setHeader("Set-Cookie", [value]);
}

function isSecureRequest(req: IncomingMessage): boolean {
  const proto = req.headers["x-forwarded-proto"];
  if (typeof proto === "string" && proto.trim().toLowerCase() === "https") {
    return true;
  }
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

function makeCookie(params: {
  token: string;
  maxAgeSeconds: number;
  path: string;
  secure: boolean;
}): string {
  const attrs = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(params.token)}`,
    `Path=${params.path}`,
    `Max-Age=${Math.max(0, Math.trunc(params.maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (params.secure) {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}

function clearCookie(params: { path: string; secure: boolean }): string {
  const attrs = [
    `${AUTH_COOKIE_NAME}=`,
    `Path=${params.path}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (params.secure) {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function resolveLocalAuthConfig(cfg: OpenClawConfig): GatewayControlUiLocalAuthConfig | undefined {
  return cfg.gateway?.controlUi?.localAuth;
}

function findLocalConfigUser(
  cfg: GatewayControlUiLocalAuthConfig | undefined,
  username: string,
): GatewayControlUiLocalAuthUser | null {
  const users = cfg?.users ?? [];
  const normalized = username.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return (
    users.find(
      (entry) => entry.username.trim().toLowerCase() === normalized && entry.disabled !== true,
    ) ?? null
  );
}

function findControlUiUser(
  cfg: OpenClawConfig,
  username: string,
): {
  username: string;
  role: "admin" | "user";
  agentId: string;
  workspace?: string;
  agentDir?: string;
  mainSessionKey: string;
  passwordHash: string;
  allowedChannels: GatewayControlUiAllowedChannel[];
} | null {
  const localAuth = resolveLocalAuthConfig(cfg);
  const normalized = username.trim();
  if (!normalized) {
    return null;
  }
  try {
    const user = findControlUiAuthDbUser(cfg, normalized);
    if (user) {
      return {
        username: user.username,
        role: user.role,
        agentId: user.agentId,
        workspace: user.workspace,
        agentDir: user.agentDir,
        mainSessionKey: user.mainSessionKey,
        passwordHash: user.passwordHash,
        allowedChannels: normalizeAllowedChannels(user.allowedChannels),
      };
    }
  } catch {
    // Fallback to config users when SQLite is unavailable in current runtime.
  }
  const configUser = findLocalConfigUser(localAuth, normalized);
  if (!configUser) {
    return null;
  }
  return {
    username: configUser.username,
    role: configUser.role,
    agentId: configUser.agentId,
    workspace: undefined,
    agentDir: undefined,
    mainSessionKey: "main",
    passwordHash: configUser.passwordHash,
    allowedChannels: normalizeAllowedChannels(configUser.allowedChannels),
  };
}

function resolveSessionSecret(cfg: OpenClawConfig): string | null {
  const input = resolveLocalAuthConfig(cfg)?.sessionSecret;
  if (typeof input === "string") {
    const normalized = input.trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (
    input &&
    typeof input === "object" &&
    (input as { source?: unknown }).source === "env" &&
    typeof (input as { id?: unknown }).id === "string"
  ) {
    const envValue = process.env[(input as { id: string }).id]?.trim();
    return envValue && envValue.length > 0 ? envValue : null;
  }
  return null;
}

async function verifyArgon2idPassword(password: string, passwordHash: string): Promise<boolean> {
  if (!passwordHash.startsWith("$argon2id$")) {
    return false;
  }
  try {
    const mod = (await import("argon2")) as {
      verify: (hash: string, plain: string) => Promise<boolean>;
    };
    return await mod.verify(passwordHash, password);
  } catch {
    throw new Error(
      "argon2 module is required for gateway.controlUi.localAuth (run `pnpm add argon2`)",
    );
  }
}

async function hashArgon2idPassword(password: string): Promise<string> {
  const plain = password.trim();
  if (!plain) {
    throw new Error("password cannot be empty");
  }
  try {
    const mod = (await import("argon2")) as {
      hash: (plainText: string, opts?: Record<string, unknown>) => Promise<string>;
    };
    return await mod.hash(plain, {
      type: 2, // argon2id
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
  } catch {
    throw new Error(
      "argon2 module is required for gateway.controlUi.localAuth (run `pnpm add -w argon2`)",
    );
  }
}

async function ensureDefaultAdminSeeded(params: {
  cfg: OpenClawConfig;
  deps: ControlUiAuthDeps;
}): Promise<
  | { ok: true }
  | {
      ok: false;
      error: string;
    }
> {
  const localAuth = resolveLocalAuthConfig(params.cfg);
  if (localAuth?.enabled !== true || !shouldSeedDefaultAdmin(localAuth)) {
    return { ok: true };
  }

  const dbPath = resolveControlUiAuthDbPathForDisplay();
  if (seededAdminDbPaths.has(dbPath)) {
    return { ok: true };
  }

  let users: ReturnType<typeof listControlUiAuthDbUsers>;
  try {
    users = listControlUiAuthDbUsers(params.cfg);
  } catch (error) {
    return { ok: false, error: `auth db unavailable: ${String(error)}` };
  }
  if (users.length > 0) {
    seededAdminDbPaths.add(dbPath);
    return { ok: true };
  }

  const password = process.env[LOCALAUTH_ADMIN_PASSWORD_ENV]?.trim() ?? "";
  const passwordHashFromEnv = process.env[LOCALAUTH_ADMIN_PASSWORD_HASH_ENV]?.trim() ?? "";
  let passwordHash = passwordHashFromEnv;
  if (password) {
    try {
      const hasher = params.deps.hashPassword ?? hashArgon2idPassword;
      passwordHash = await hasher(password);
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
  if (!passwordHash) {
    return {
      ok: false,
      error:
        `local auth is enabled and auth DB is empty; set ${LOCALAUTH_ADMIN_PASSWORD_ENV} ` +
        `or ${LOCALAUTH_ADMIN_PASSWORD_HASH_ENV} before first login`,
    };
  }
  try {
    upsertControlUiAuthDbUser({
      cfg: params.cfg,
      user: {
        username: resolveSeedAdminUsername(localAuth),
        passwordHash,
        role: "admin",
        agentId: resolveSeedAdminAgentId(),
        mainSessionKey: "main",
        allowedChannels: [],
        disabled: false,
      },
    });
  } catch (error) {
    return { ok: false, error: `auth db unavailable: ${String(error)}` };
  }
  seededAdminDbPaths.add(dbPath);
  return { ok: true };
}

export function resolveControlUiViewerFromRequest(params: {
  req: IncomingMessage;
  cfg: OpenClawConfig;
  deps?: ControlUiAuthDeps;
}): ControlUiViewer | null {
  const localAuth = resolveLocalAuthConfig(params.cfg);
  if (localAuth?.enabled !== true) {
    return null;
  }
  const sessionSecret = resolveSessionSecret(params.cfg);
  if (!sessionSecret) {
    return null;
  }
  const nowMs = params.deps?.nowMs?.() ?? Date.now();
  const token = parseCookieHeader(params.req).get(AUTH_COOKIE_NAME);
  if (!token) {
    return null;
  }
  const payload = verifySessionToken(decodeURIComponent(token), sessionSecret);
  if (!payload || payload.expMs <= nowMs) {
    return null;
  }
  const user = findControlUiUser(params.cfg, payload.username);
  if (!user) {
    return null;
  }
  return {
    username: user.username,
    role: user.role,
    agentId: user.agentId,
    mainSessionKey: user.mainSessionKey,
    allowedChannels: normalizeAllowedChannels(user.allowedChannels),
  };
}

export async function handleControlUiAuthHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  cfg: OpenClawConfig;
  basePath?: string;
  deps?: ControlUiAuthDeps;
}): Promise<boolean> {
  const { req, res, cfg } = params;
  const localAuth = resolveLocalAuthConfig(cfg);
  const basePath = normalizeControlUiBasePath(params.basePath);
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const authPrefix = basePath ? `${basePath}${CONTROL_UI_AUTH_PREFIX}` : CONTROL_UI_AUTH_PREFIX;
  if (!url.pathname.startsWith(authPrefix)) {
    return false;
  }
  if (localAuth?.enabled !== true) {
    sendJson(res, 404, { ok: false, error: "local auth not enabled" });
    return true;
  }

  const deps = params.deps ?? {};
  const seedStatus = await ensureDefaultAdminSeeded({ cfg, deps });
  if (!seedStatus.ok) {
    sendJson(res, 503, { ok: false, error: seedStatus.error });
    return true;
  }
  const nowMs = deps.nowMs?.() ?? Date.now();
  const sessionSecret = resolveSessionSecret(cfg);
  if (!sessionSecret) {
    sendJson(res, 503, { ok: false, error: "local auth session secret not configured" });
    return true;
  }

  const secure = isSecureRequest(req);
  const cookiePath = basePath || "/";
  const resolveViewerOrUnauthorized = (): ControlUiViewer | null => {
    const viewer = resolveControlUiViewerFromRequest({ req, cfg, deps });
    if (!viewer) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return null;
    }
    return viewer;
  };

  if (url.pathname === `${authPrefix}/me`) {
    if (method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    const viewer = resolveControlUiViewerFromRequest({ req, cfg, deps });
    if (!viewer) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }
    sendJson(res, 200, { ok: true, viewer });
    return true;
  }

  if (url.pathname === `${authPrefix}/logout`) {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    appendSetCookie(res, clearCookie({ path: cookiePath, secure }));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === `${authPrefix}/users`) {
    const viewer = resolveViewerOrUnauthorized();
    if (!viewer) {
      return true;
    }
    if (viewer.role !== "admin") {
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return true;
    }
    if (method === "GET") {
      let dbUsers;
      try {
        dbUsers = listControlUiAuthDbUsers(cfg);
      } catch (error) {
        sendJson(res, 503, {
          ok: false,
          error: `auth db unavailable: ${String(error)}`,
        });
        return true;
      }
      const users = dbUsers.map((entry) => ({
        username: entry.username,
        role: entry.role,
        agentId: entry.agentId,
        workspace: entry.workspace,
        agentDir: entry.agentDir,
        mainSessionKey: entry.mainSessionKey,
        allowedChannels: normalizeAllowedChannels(entry.allowedChannels),
        disabled: entry.disabled,
      }));
      sendJson(res, 200, {
        ok: true,
        dbPath: resolveControlUiAuthDbPathForDisplay(),
        users,
      });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    const body = await readAuthJsonBody(req, AUTH_COOKIE_MAX_BYTES);
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: body.error });
      return true;
    }
    const payload = typeof body.value === "object" && body.value ? body.value : {};
    const action =
      typeof (payload as { action?: unknown }).action === "string"
        ? (payload as { action: string }).action.trim().toLowerCase()
        : "";
    if (action === "delete") {
      const username =
        typeof (payload as { username?: unknown }).username === "string"
          ? (payload as { username: string }).username.trim()
          : "";
      if (!username) {
        sendJson(res, 400, { ok: false, error: "username required" });
        return true;
      }
      if (username.toLowerCase() === viewer.username.toLowerCase()) {
        sendJson(res, 400, { ok: false, error: "cannot delete current admin session user" });
        return true;
      }
      let deleted = false;
      try {
        deleted = deleteControlUiAuthDbUser({ cfg, username });
      } catch (error) {
        sendJson(res, 503, {
          ok: false,
          error: `auth db unavailable: ${String(error)}`,
        });
        return true;
      }
      sendJson(res, 200, { ok: true, deleted });
      return true;
    }
    if (action === "bootstrap-agent") {
      const username =
        typeof (payload as { username?: unknown }).username === "string"
          ? (payload as { username: string }).username.trim()
          : "";
      if (!username) {
        sendJson(res, 400, { ok: false, error: "username required" });
        return true;
      }
      let user = null;
      try {
        user = findControlUiAuthDbUser(cfg, username);
      } catch {
        user = null;
      }
      if (!user) {
        sendJson(res, 404, { ok: false, error: "user not found" });
        return true;
      }
      try {
        const currentCfg = loadConfig();
        const workspace =
          user.workspace?.trim() || resolveAgentWorkspaceDir(currentCfg, user.agentId);
        const agentDir = user.agentDir?.trim() || resolveAgentDir(currentCfg, user.agentId);
        await ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true });
        const nextCfg = applyAgentConfig(currentCfg, {
          agentId: user.agentId,
          name: user.username,
          workspace,
          agentDir,
        });
        await writeConfigFile(nextCfg);
        upsertControlUiAuthDbUser({
          cfg,
          user: {
            ...user,
            workspace,
            agentDir,
          },
        });
        sendJson(res, 200, {
          ok: true,
          profile: {
            username: user.username,
            role: user.role,
            agentId: user.agentId,
            workspace,
            agentDir,
            mainSessionKey: user.mainSessionKey,
            sessionKey: buildAgentMainSessionKey({
              agentId: user.agentId,
              mainKey: user.mainSessionKey,
            }),
            allowedChannels: normalizeAllowedChannels(user.allowedChannels),
            disabled: user.disabled,
          },
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: `bootstrap agent failed: ${String(error)}`,
        });
      }
      return true;
    }
    const username =
      typeof (payload as { username?: unknown }).username === "string"
        ? (payload as { username: string }).username.trim()
        : "";
    const role = (payload as { role?: unknown }).role;
    const agentId =
      typeof (payload as { agentId?: unknown }).agentId === "string"
        ? (payload as { agentId: string }).agentId.trim()
        : "";
    const workspace =
      typeof (payload as { workspace?: unknown }).workspace === "string"
        ? (payload as { workspace: string }).workspace.trim()
        : "";
    const agentDir =
      typeof (payload as { agentDir?: unknown }).agentDir === "string"
        ? (payload as { agentDir: string }).agentDir.trim()
        : "";
    const mainSessionKey =
      typeof (payload as { mainSessionKey?: unknown }).mainSessionKey === "string"
        ? (payload as { mainSessionKey: string }).mainSessionKey.trim()
        : "";
    const disabled = (payload as { disabled?: unknown }).disabled === true;
    const passwordHash =
      typeof (payload as { passwordHash?: unknown }).passwordHash === "string"
        ? (payload as { passwordHash: string }).passwordHash.trim()
        : "";
    const password =
      typeof (payload as { password?: unknown }).password === "string"
        ? (payload as { password: string }).password
        : "";
    const allowedChannelsRaw = (payload as { allowedChannels?: unknown }).allowedChannels;
    const allowedChannels = Array.isArray(allowedChannelsRaw)
      ? normalizeAllowedChannels(
          allowedChannelsRaw.filter((entry): entry is GatewayControlUiAllowedChannel => {
            return Boolean(entry && typeof entry === "object");
          }),
        )
      : [];
    if (!username || !agentId) {
      sendJson(res, 400, { ok: false, error: "username and agentId required" });
      return true;
    }
    if (role !== "admin" && role !== "user") {
      sendJson(res, 400, { ok: false, error: "role must be admin or user" });
      return true;
    }
    let existing = null;
    try {
      existing = findControlUiAuthDbUser(cfg, username);
    } catch {
      existing = null;
    }
    let resolvedPasswordHash = passwordHash || existing?.passwordHash || "";
    if (password.trim()) {
      try {
        resolvedPasswordHash = await hashArgon2idPassword(password);
      } catch (error) {
        sendJson(res, 503, { ok: false, error: String(error) });
        return true;
      }
    }
    if (!resolvedPasswordHash) {
      sendJson(res, 400, { ok: false, error: "password required for new users" });
      return true;
    }
    try {
      upsertControlUiAuthDbUser({
        cfg,
        user: {
          username,
          role,
          agentId,
          workspace: workspace || undefined,
          agentDir: agentDir || undefined,
          mainSessionKey: mainSessionKey || "main",
          passwordHash: resolvedPasswordHash,
          allowedChannels,
          disabled,
        },
      });
    } catch (error) {
      sendJson(res, 503, {
        ok: false,
        error: `auth db unavailable: ${String(error)}`,
      });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  {
    const userProfilePrefix = `${authPrefix}/users/`;
    if (url.pathname.startsWith(userProfilePrefix) && url.pathname.endsWith("/profile")) {
      const viewer = resolveViewerOrUnauthorized();
      if (!viewer) {
        return true;
      }
      if (viewer.role !== "admin") {
        sendJson(res, 403, { ok: false, error: "forbidden" });
        return true;
      }
      const encodedUsername = url.pathname
        .slice(userProfilePrefix.length, -"/profile".length)
        .replace(/\/+$/, "");
      const username = decodeURIComponent(encodedUsername).trim();
      if (!username) {
        sendJson(res, 400, { ok: false, error: "username required" });
        return true;
      }
      if (method === "GET") {
        let user = null;
        try {
          user = findControlUiAuthDbUser(cfg, username);
        } catch (error) {
          sendJson(res, 503, {
            ok: false,
            error: `auth db unavailable: ${String(error)}`,
          });
          return true;
        }
        if (!user) {
          sendJson(res, 404, { ok: false, error: "user not found" });
          return true;
        }
        sendJson(res, 200, {
          ok: true,
          profile: {
            username: user.username,
            role: user.role,
            agentId: user.agentId,
            workspace: user.workspace,
            agentDir: user.agentDir,
            mainSessionKey: user.mainSessionKey,
            allowedChannels: normalizeAllowedChannels(user.allowedChannels),
            disabled: user.disabled,
          },
        });
        return true;
      }
      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return true;
      }
      const body = await readAuthJsonBody(req, AUTH_COOKIE_MAX_BYTES);
      if (!body.ok) {
        sendJson(res, 400, { ok: false, error: body.error });
        return true;
      }
      const payload = typeof body.value === "object" && body.value ? body.value : {};
      const role = (payload as { role?: unknown }).role;
      const agentId =
        typeof (payload as { agentId?: unknown }).agentId === "string"
          ? (payload as { agentId: string }).agentId.trim()
          : "";
      const workspace =
        typeof (payload as { workspace?: unknown }).workspace === "string"
          ? (payload as { workspace: string }).workspace.trim()
          : "";
      const agentDir =
        typeof (payload as { agentDir?: unknown }).agentDir === "string"
          ? (payload as { agentDir: string }).agentDir.trim()
          : "";
      const mainSessionKey =
        typeof (payload as { mainSessionKey?: unknown }).mainSessionKey === "string"
          ? (payload as { mainSessionKey: string }).mainSessionKey.trim()
          : "";
      const disabled = (payload as { disabled?: unknown }).disabled === true;
      const password =
        typeof (payload as { password?: unknown }).password === "string"
          ? (payload as { password: string }).password
          : "";
      const passwordHash =
        typeof (payload as { passwordHash?: unknown }).passwordHash === "string"
          ? (payload as { passwordHash: string }).passwordHash.trim()
          : "";
      const allowedChannelsRaw = (payload as { allowedChannels?: unknown }).allowedChannels;
      const allowedChannels = Array.isArray(allowedChannelsRaw)
        ? normalizeAllowedChannels(
            allowedChannelsRaw.filter((entry): entry is GatewayControlUiAllowedChannel => {
              return Boolean(entry && typeof entry === "object");
            }),
          )
        : [];
      if (!agentId) {
        sendJson(res, 400, { ok: false, error: "agentId required" });
        return true;
      }
      if (role !== "admin" && role !== "user") {
        sendJson(res, 400, { ok: false, error: "role must be admin or user" });
        return true;
      }
      let existing = null;
      try {
        existing = findControlUiAuthDbUser(cfg, username);
      } catch {
        existing = null;
      }
      if (!existing) {
        sendJson(res, 404, { ok: false, error: "user not found" });
        return true;
      }
      let resolvedPasswordHash = passwordHash || existing.passwordHash || "";
      if (password.trim()) {
        try {
          resolvedPasswordHash = await hashArgon2idPassword(password);
        } catch (error) {
          sendJson(res, 503, { ok: false, error: String(error) });
          return true;
        }
      }
      if (!resolvedPasswordHash) {
        sendJson(res, 400, { ok: false, error: "passwordHash required" });
        return true;
      }
      try {
        upsertControlUiAuthDbUser({
          cfg,
          user: {
            username,
            role,
            agentId,
            workspace: workspace || undefined,
            agentDir: agentDir || undefined,
            mainSessionKey: mainSessionKey || "main",
            passwordHash: resolvedPasswordHash,
            allowedChannels,
            disabled,
          },
        });
      } catch (error) {
        sendJson(res, 503, {
          ok: false,
          error: `auth db unavailable: ${String(error)}`,
        });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  if (url.pathname === `${authPrefix}/login`) {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    const body = await readAuthJsonBody(req, AUTH_COOKIE_MAX_BYTES);
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: body.error });
      return true;
    }
    const payload = typeof body.value === "object" && body.value ? body.value : {};
    const username =
      typeof (payload as { username?: unknown }).username === "string"
        ? (payload as { username: string }).username.trim()
        : "";
    const password =
      typeof (payload as { password?: unknown }).password === "string"
        ? (payload as { password: string }).password
        : "";
    if (!username || !password) {
      sendJson(res, 400, { ok: false, error: "username and password required" });
      return true;
    }
    const user = findControlUiUser(cfg, username);
    if (!user) {
      sendJson(res, 401, { ok: false, error: "invalid credentials" });
      return true;
    }
    const verifier = deps.verifyPassword ?? verifyArgon2idPassword;
    let verified = false;
    try {
      verified = await verifier(password, user.passwordHash);
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error) });
      return true;
    }
    if (!verified) {
      sendJson(res, 401, { ok: false, error: "invalid credentials" });
      return true;
    }
    const sessionTtlHours = resolveSessionTtlHours(localAuth);
    const token = createSessionToken(
      {
        version: SESSION_VERSION,
        username: user.username,
        iatMs: nowMs,
        expMs: nowMs + sessionTtlHours * 60 * 60 * 1000,
      },
      sessionSecret,
    );
    appendSetCookie(
      res,
      makeCookie({
        token,
        maxAgeSeconds: sessionTtlHours * 60 * 60,
        path: cookiePath,
        secure,
      }),
    );
    sendJson(res, 200, {
      ok: true,
      viewer: {
        username: user.username,
        role: user.role,
        agentId: user.agentId,
        mainSessionKey: user.mainSessionKey,
        allowedChannels: normalizeAllowedChannels(user.allowedChannels),
      } satisfies ControlUiViewer,
    });
    return true;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
  return true;
}
