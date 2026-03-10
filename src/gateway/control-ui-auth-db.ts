import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type {
  GatewayControlUiAllowedChannel,
  GatewayControlUiLocalAuthConfig,
  GatewayControlUiLocalAuthUser,
} from "../config/types.gateway.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

export type ControlUiAuthDbUser = {
  username: string;
  passwordHash: string;
  role: "admin" | "user";
  agentId: string;
  workspace?: string;
  agentDir?: string;
  mainSessionKey: string;
  allowedChannels: GatewayControlUiAllowedChannel[];
  disabled: boolean;
};

const DEFAULT_AUTH_DB_FILE = "control-ui-auth.db";
const seededDbPaths = new Set<string>();

function resolveLocalAuthConfig(cfg: OpenClawConfig): GatewayControlUiLocalAuthConfig | undefined {
  return cfg.gateway?.controlUi?.localAuth;
}

function resolveAuthDbPath(): string {
  const explicit = process.env.OPENCLAW_CONTROL_UI_AUTH_DB_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(resolveStateDir(process.env), DEFAULT_AUTH_DB_FILE);
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

function normalizeMainSessionKey(value: string | undefined): string {
  const normalized = (value ?? "").trim();
  return normalized || "main";
}

function normalizeSeedUser(user: GatewayControlUiLocalAuthUser): ControlUiAuthDbUser {
  return {
    username: user.username.trim(),
    passwordHash: user.passwordHash,
    role: user.role,
    agentId: user.agentId.trim().toLowerCase(),
    workspace: undefined,
    agentDir: undefined,
    mainSessionKey: "main",
    allowedChannels: normalizeAllowedChannels(user.allowedChannels),
    disabled: user.disabled === true,
  };
}

function setupSchema(db: import("node:sqlite").DatabaseSync) {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','user')),
      agent_id TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_allowed_channels (
      username TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT,
      PRIMARY KEY (username, channel, account_id),
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_agent_profiles (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      agent_id TEXT NOT NULL,
      workspace TEXT,
      agent_dir TEXT,
      main_session_key TEXT NOT NULL DEFAULT 'main',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );
  `);
}

function seedUsersIfNeeded(params: {
  db: import("node:sqlite").DatabaseSync;
  cfg: OpenClawConfig;
  dbPath: string;
}) {
  if (seededDbPaths.has(params.dbPath)) {
    return;
  }
  const countRow = params.db.prepare(`SELECT COUNT(*) AS total FROM users`).get() as
    | { total?: number }
    | undefined;
  if ((countRow?.total ?? 0) > 0) {
    seededDbPaths.add(params.dbPath);
    return;
  }
  const localAuth = resolveLocalAuthConfig(params.cfg);
  const users = localAuth?.users ?? [];
  if (users.length === 0) {
    return;
  }
  const nowMs = Date.now();
  const insertUser = params.db.prepare(`
    INSERT OR IGNORE INTO users
      (username, password_hash, role, agent_id, disabled, created_at_ms, updated_at_ms)
    VALUES
      (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChannel = params.db.prepare(`
    INSERT OR IGNORE INTO user_allowed_channels (username, channel, account_id)
    VALUES (?, ?, ?)
  `);
  const upsertProfile = params.db.prepare(`
    INSERT INTO user_agent_profiles
      (username, agent_id, workspace, agent_dir, main_session_key, created_at_ms, updated_at_ms)
    VALUES
      (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      agent_id = excluded.agent_id,
      workspace = excluded.workspace,
      agent_dir = excluded.agent_dir,
      main_session_key = excluded.main_session_key,
      updated_at_ms = excluded.updated_at_ms
  `);

  const seedItems = users.map(normalizeSeedUser);
  params.db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    for (const seedItem of seedItems) {
      const result = insertUser.run(
        seedItem.username,
        seedItem.passwordHash,
        seedItem.role,
        seedItem.agentId,
        seedItem.disabled ? 1 : 0,
        nowMs,
        nowMs,
      ) as { changes?: number };
      upsertProfile.run(
        seedItem.username,
        seedItem.agentId,
        seedItem.workspace ?? null,
        seedItem.agentDir ?? null,
        seedItem.mainSessionKey,
        nowMs,
        nowMs,
      );
      if ((result.changes ?? 0) > 0) {
        for (const channel of seedItem.allowedChannels) {
          insertChannel.run(seedItem.username, channel.channel, channel.accountId ?? null);
        }
      }
    }
    params.db.exec("COMMIT");
  } catch (error) {
    params.db.exec("ROLLBACK");
    throw error;
  }
  seededDbPaths.add(params.dbPath);
}

function openAuthDb(cfg: OpenClawConfig): {
  db: import("node:sqlite").DatabaseSync;
  close: () => void;
} {
  const dbPath = resolveAuthDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  setupSchema(db);
  seedUsersIfNeeded({ db, cfg, dbPath });
  return {
    db,
    close: () => db.close(),
  };
}

function listAllowedChannelsForUser(
  db: import("node:sqlite").DatabaseSync,
  username: string,
): GatewayControlUiAllowedChannel[] {
  const rows = db
    .prepare(
      `
      SELECT channel, account_id
      FROM user_allowed_channels
      WHERE username = ?
      ORDER BY channel ASC, account_id ASC
    `,
    )
    .all(username) as Array<{ channel: string; account_id: string | null }>;
  return rows.map((row) => ({
    channel: row.channel,
    accountId: row.account_id ?? undefined,
  }));
}

function getAgentProfileForUser(
  db: import("node:sqlite").DatabaseSync,
  username: string,
): {
  agentId: string;
  workspace?: string;
  agentDir?: string;
  mainSessionKey: string;
} | null {
  const row = db
    .prepare(
      `
      SELECT agent_id, workspace, agent_dir, main_session_key
      FROM user_agent_profiles
      WHERE lower(username) = lower(?)
      LIMIT 1
    `,
    )
    .get(username) as
    | {
        agent_id: string;
        workspace: string | null;
        agent_dir: string | null;
        main_session_key: string | null;
      }
    | undefined;
  if (!row) {
    return null;
  }
  return {
    agentId: row.agent_id,
    workspace: row.workspace ?? undefined,
    agentDir: row.agent_dir ?? undefined,
    mainSessionKey: normalizeMainSessionKey(row.main_session_key ?? undefined),
  };
}

export function findControlUiAuthDbUser(
  cfg: OpenClawConfig,
  username: string,
): ControlUiAuthDbUser | null {
  const normalized = username.trim();
  if (!normalized) {
    return null;
  }
  const { db, close } = openAuthDb(cfg);
  try {
    const row = db
      .prepare(
        `
      SELECT username, password_hash, role, agent_id, disabled
      FROM users
      WHERE lower(username) = lower(?)
      LIMIT 1
    `,
      )
      .get(normalized) as
      | {
          username: string;
          password_hash: string;
          role: "admin" | "user";
          agent_id: string;
          disabled: number;
        }
      | undefined;
    if (!row || row.disabled === 1) {
      return null;
    }
    const profile = getAgentProfileForUser(db, row.username);
    const resolvedAgentId = profile?.agentId?.trim().toLowerCase() || row.agent_id;
    return {
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      agentId: resolvedAgentId,
      workspace: profile?.workspace,
      agentDir: profile?.agentDir,
      mainSessionKey: profile?.mainSessionKey ?? "main",
      allowedChannels: listAllowedChannelsForUser(db, row.username),
      disabled: row.disabled === 1,
    };
  } finally {
    close();
  }
}

export function listControlUiAuthDbUsers(cfg: OpenClawConfig): ControlUiAuthDbUser[] {
  const { db, close } = openAuthDb(cfg);
  try {
    const rows = db
      .prepare(
        `
      SELECT username, password_hash, role, agent_id, disabled
      FROM users
      ORDER BY lower(username) ASC
    `,
      )
      .all() as Array<{
      username: string;
      password_hash: string;
      role: "admin" | "user";
      agent_id: string;
      disabled: number;
    }>;
    return rows.map((row) => {
      const profile = getAgentProfileForUser(db, row.username);
      const resolvedAgentId = profile?.agentId?.trim().toLowerCase() || row.agent_id;
      return {
        username: row.username,
        passwordHash: row.password_hash,
        role: row.role,
        agentId: resolvedAgentId,
        workspace: profile?.workspace,
        agentDir: profile?.agentDir,
        mainSessionKey: profile?.mainSessionKey ?? "main",
        allowedChannels: listAllowedChannelsForUser(db, row.username),
        disabled: row.disabled === 1,
      };
    });
  } finally {
    close();
  }
}

export function upsertControlUiAuthDbUser(params: {
  cfg: OpenClawConfig;
  user: ControlUiAuthDbUser;
}) {
  const user = {
    ...params.user,
    username: params.user.username.trim(),
    agentId: params.user.agentId.trim().toLowerCase(),
    workspace: params.user.workspace?.trim() || undefined,
    agentDir: params.user.agentDir?.trim() || undefined,
    mainSessionKey: normalizeMainSessionKey(params.user.mainSessionKey),
    allowedChannels: normalizeAllowedChannels(params.user.allowedChannels),
  };
  const { db, close } = openAuthDb(params.cfg);
  try {
    const nowMs = Date.now();
    const existing = db
      .prepare(`SELECT username, created_at_ms FROM users WHERE lower(username)=lower(?) LIMIT 1`)
      .get(user.username) as { username: string; created_at_ms: number } | undefined;
    const username = existing?.username ?? user.username;
    const createdAtMs = existing?.created_at_ms ?? nowMs;
    db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      db.prepare(
        `
        INSERT INTO users (username, password_hash, role, agent_id, disabled, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
          password_hash = excluded.password_hash,
          role = excluded.role,
          agent_id = excluded.agent_id,
          disabled = excluded.disabled,
          updated_at_ms = excluded.updated_at_ms
      `,
      ).run(
        username,
        user.passwordHash,
        user.role,
        user.agentId,
        user.disabled ? 1 : 0,
        createdAtMs,
        nowMs,
      );
      db.prepare(`DELETE FROM user_allowed_channels WHERE username = ?`).run(username);
      db.prepare(
        `
        INSERT INTO user_agent_profiles
          (username, agent_id, workspace, agent_dir, main_session_key, created_at_ms, updated_at_ms)
        VALUES
          (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
          agent_id = excluded.agent_id,
          workspace = excluded.workspace,
          agent_dir = excluded.agent_dir,
          main_session_key = excluded.main_session_key,
          updated_at_ms = excluded.updated_at_ms
      `,
      ).run(
        username,
        user.agentId,
        user.workspace ?? null,
        user.agentDir ?? null,
        user.mainSessionKey,
        createdAtMs,
        nowMs,
      );
      const insertChannel = db.prepare(
        `INSERT OR IGNORE INTO user_allowed_channels (username, channel, account_id) VALUES (?, ?, ?)`,
      );
      for (const channel of user.allowedChannels) {
        insertChannel.run(username, channel.channel, channel.accountId ?? null);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    close();
  }
}

export function deleteControlUiAuthDbUser(params: {
  cfg: OpenClawConfig;
  username: string;
}): boolean {
  const username = params.username.trim();
  if (!username) {
    return false;
  }
  const { db, close } = openAuthDb(params.cfg);
  try {
    const result = db.prepare(`DELETE FROM users WHERE lower(username)=lower(?)`).run(username) as {
      changes?: number;
    };
    return (result.changes ?? 0) > 0;
  } finally {
    close();
  }
}

export function resolveControlUiAuthDbPathForDisplay(): string {
  return resolveAuthDbPath();
}
