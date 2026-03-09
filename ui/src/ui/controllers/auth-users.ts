import type { GatewayBrowserClient } from "../gateway.ts";
import { normalizeBasePath } from "../navigation.ts";
import type { AgentsListResult, ChannelsStatusSnapshot } from "../types.ts";
import type { AuthViewer } from "./auth.ts";

export type ControlUiUserEntry = {
  username: string;
  role: "admin" | "user";
  agentId: string;
  workspace?: string;
  agentDir?: string;
  mainSessionKey: string;
  disabled: boolean;
  allowedChannels: Array<{ channel: string; accountId?: string }>;
};

export type AuthUsersState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  basePath: string;
  authViewer: AuthViewer | null;
  agentsList: AgentsListResult | null;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  authUsersLoading: boolean;
  authUsersError: string | null;
  authUsersList: ControlUiUserEntry[];
  authUsersDbPath: string | null;
  authUsersSelected: string | null;
  authUsersForm: {
    username: string;
    role: "admin" | "user";
    agentId: string;
    workspace: string;
    agentDir: string;
    mainSessionKey: string;
    agentModel: string;
    password: string;
    passwordHash: string;
    disabled: boolean;
    allowedChannelsText: string;
  };
  authUsersSaving: boolean;
  authUsersDeleting: boolean;
  authUsersWizardStep: 1 | 2 | 3 | 4 | 5;
  authUsersAutoBootstrap: boolean;
  authUsersBootstrapBusy: boolean;
  authUsersBootstrapError: string | null;
  authUsersChannelWarnings: string[];
  authUsersChannelDraftChannel: string;
  authUsersChannelDraftAccountId: string;
  authUsersCreateAgentOpen: boolean;
  authUsersCreateAgentBusy: boolean;
  authUsersCreateAgentError: string | null;
  authUsersCreateAgentForm: {
    name: string;
    workspace: string;
    model: string;
  };
};

function authEndpoint(basePath: string): string {
  const normalizedBasePath = normalizeBasePath(basePath ?? "");
  const prefix = `${normalizedBasePath}/__openclaw__/auth`.replace(/\/{2,}/g, "/");
  return `${prefix}/users`;
}

function parseAllowedChannelsText(input: string): Array<{ channel: string; accountId?: string }> {
  const output: Array<{ channel: string; accountId?: string }> = [];
  for (const rawLine of input.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const [channelRaw, accountIdRaw] = line.split(":");
    const channel = (channelRaw ?? "").trim().toLowerCase();
    if (!channel) {
      continue;
    }
    const accountId = (accountIdRaw ?? "").trim();
    output.push({
      channel,
      accountId: accountId || undefined,
    });
  }
  return output;
}

function formatAllowedChannelsText(
  entries: Array<{ channel: string; accountId?: string }>,
): string {
  return entries
    .map((entry) => `${entry.channel}${entry.accountId ? `:${entry.accountId}` : ""}`)
    .join("\n");
}

function ensureAdmin(state: AuthUsersState): boolean {
  return state.authViewer?.role === "admin";
}

function buildChannelsWarnings(
  state: Pick<AuthUsersState, "channelsSnapshot" | "authUsersForm">,
): string[] {
  const snapshot = state.channelsSnapshot;
  const warnings: string[] = [];
  const parsed = parseAllowedChannelsText(state.authUsersForm.allowedChannelsText);
  if (parsed.length === 0) {
    return warnings;
  }
  const channelAccounts = snapshot?.channelAccounts ?? {};
  const channelAccountsByLower = new Map<
    string,
    Array<{ accountId?: string; name?: string | null }>
  >();
  for (const [channel, accounts] of Object.entries(channelAccounts)) {
    channelAccountsByLower.set(channel.toLowerCase(), accounts);
  }
  const knownChannels = new Set(channelAccountsByLower.keys());
  for (const entry of parsed) {
    const channel = entry.channel.toLowerCase();
    if (!knownChannels.has(channel)) {
      warnings.push(`Channel "${channel}" not found in gateway status.`);
      continue;
    }
    if (!entry.accountId) {
      continue;
    }
    const accounts = channelAccountsByLower.get(channel) ?? [];
    const exists = accounts.some((account) => {
      const accountId = typeof account.accountId === "string" ? account.accountId.trim() : "";
      const name = typeof account.name === "string" ? account.name.trim() : "";
      return accountId === entry.accountId || name === entry.accountId;
    });
    if (!exists) {
      warnings.push(`Account "${entry.accountId}" not found for channel "${channel}".`);
    }
  }
  return warnings;
}

export function validateAuthUsersAllowedChannels(state: AuthUsersState) {
  const warnings = buildChannelsWarnings(state);
  const currentUsername = state.authUsersForm.username.trim().toLowerCase();
  const currentAgentId = state.authUsersForm.agentId.trim().toLowerCase();
  if (currentAgentId) {
    for (const user of state.authUsersList) {
      if (user.username.trim().toLowerCase() === currentUsername) {
        continue;
      }
      if (user.agentId.trim().toLowerCase() === currentAgentId) {
        warnings.push(`Agent "${currentAgentId}" is already assigned to user "${user.username}".`);
      }
    }
  }
  const currentBindings = parseAllowedChannelsText(state.authUsersForm.allowedChannelsText);
  for (const user of state.authUsersList) {
    if (user.username.trim().toLowerCase() === currentUsername) {
      continue;
    }
    for (const binding of currentBindings) {
      const conflict = user.allowedChannels.some((entry) => {
        const sameChannel =
          entry.channel.trim().toLowerCase() === binding.channel.trim().toLowerCase();
        if (!sameChannel) {
          return false;
        }
        const a = entry.accountId?.trim() || "";
        const b = binding.accountId?.trim() || "";
        return a === b;
      });
      if (conflict) {
        warnings.push(
          `Binding "${binding.channel}${binding.accountId ? `:${binding.accountId}` : ""}" is already used by user "${user.username}".`,
        );
      }
    }
  }
  state.authUsersChannelWarnings = warnings;
}

export function chooseAuthUsersAgent(state: AuthUsersState, agentId: string) {
  const normalized = agentId.trim().toLowerCase();
  if (!normalized) {
    return;
  }
  state.authUsersForm = {
    ...state.authUsersForm,
    agentId: normalized,
    mainSessionKey: state.authUsersForm.mainSessionKey.trim() || "main",
  };
  validateAuthUsersAllowedChannels(state);
}

export function openAuthUsersCreateAgent(state: AuthUsersState) {
  state.authUsersCreateAgentError = null;
  state.authUsersCreateAgentOpen = true;
}

export function cancelAuthUsersCreateAgent(state: AuthUsersState) {
  state.authUsersCreateAgentOpen = false;
  state.authUsersCreateAgentBusy = false;
  state.authUsersCreateAgentError = null;
}

export async function createAuthUsersAgent(state: AuthUsersState): Promise<boolean> {
  if (!state.client || !state.connected) {
    state.authUsersCreateAgentError = "gateway not connected";
    return false;
  }
  const name = state.authUsersCreateAgentForm.name.trim();
  const workspace = state.authUsersCreateAgentForm.workspace.trim();
  const model = state.authUsersCreateAgentForm.model.trim();
  if (!name || !workspace) {
    state.authUsersCreateAgentError = "name and workspace required";
    return false;
  }
  state.authUsersCreateAgentBusy = true;
  state.authUsersCreateAgentError = null;
  try {
    const created = await state.client.request<{ ok: true; agentId: string; workspace: string }>(
      "agents.create",
      { name, workspace },
    );
    if (model) {
      await state.client.request("agents.update", {
        agentId: created.agentId,
        model,
      });
    }
    const agents = await state.client.request<AgentsListResult>("agents.list", {});
    state.agentsList = agents;
    state.authUsersForm = {
      ...state.authUsersForm,
      agentId: created.agentId,
      workspace: created.workspace,
    };
    state.authUsersCreateAgentOpen = false;
    state.authUsersCreateAgentForm = {
      name: "",
      workspace: "",
      model: "",
    };
    validateAuthUsersAllowedChannels(state);
    return true;
  } catch (error) {
    state.authUsersCreateAgentError = String(error);
    return false;
  } finally {
    state.authUsersCreateAgentBusy = false;
  }
}

export async function loadAuthUsers(state: AuthUsersState) {
  if (!ensureAdmin(state)) {
    return;
  }
  state.authUsersLoading = true;
  state.authUsersError = null;
  try {
    const res = await fetch(authEndpoint(state.basePath), {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      dbPath?: string;
      users?: ControlUiUserEntry[];
    };
    if (!res.ok || payload.ok !== true) {
      state.authUsersError = payload.error || `load users failed (${res.status})`;
      return;
    }
    state.authUsersList = Array.isArray(payload.users) ? payload.users : [];
    state.authUsersDbPath = typeof payload.dbPath === "string" ? payload.dbPath : null;
  } catch (error) {
    state.authUsersError = String(error);
  } finally {
    state.authUsersLoading = false;
  }
}

export function selectAuthUser(state: AuthUsersState, username: string | null) {
  state.authUsersSelected = username;
  state.authUsersBootstrapError = null;
  if (!username) {
    state.authUsersForm = {
      username: "",
      role: "user",
      agentId: "",
      workspace: "",
      agentDir: "",
      mainSessionKey: "main",
      agentModel: "",
      password: "",
      passwordHash: "",
      disabled: false,
      allowedChannelsText: "",
    };
    state.authUsersWizardStep = 1;
    state.authUsersChannelDraftChannel = "";
    state.authUsersChannelDraftAccountId = "";
    validateAuthUsersAllowedChannels(state);
    return;
  }
  const entry = state.authUsersList.find((item) => item.username === username);
  if (!entry) {
    return;
  }
  state.authUsersForm = {
    username: entry.username,
    role: entry.role,
    agentId: entry.agentId,
    workspace: entry.workspace ?? "",
    agentDir: entry.agentDir ?? "",
    mainSessionKey: entry.mainSessionKey || "main",
    agentModel: "",
    password: "",
    passwordHash: "",
    disabled: entry.disabled,
    allowedChannelsText: formatAllowedChannelsText(entry.allowedChannels ?? []),
  };
  state.authUsersWizardStep = 1;
  state.authUsersChannelDraftChannel = "";
  state.authUsersChannelDraftAccountId = "";
  validateAuthUsersAllowedChannels(state);
}

export function addAuthUsersAllowedChannelBinding(state: AuthUsersState) {
  const channel = state.authUsersChannelDraftChannel.trim().toLowerCase();
  if (!channel) {
    return;
  }
  const accountRaw = state.authUsersChannelDraftAccountId.trim();
  const accountId = accountRaw && accountRaw !== "*" ? accountRaw : undefined;
  const current = parseAllowedChannelsText(state.authUsersForm.allowedChannelsText);
  const exists = current.some(
    (entry) => entry.channel === channel && (entry.accountId ?? "") === (accountId ?? ""),
  );
  if (exists) {
    return;
  }
  current.push({ channel, accountId });
  state.authUsersForm = {
    ...state.authUsersForm,
    allowedChannelsText: formatAllowedChannelsText(current),
  };
  validateAuthUsersAllowedChannels(state);
}

export function removeAuthUsersAllowedChannelBinding(
  state: AuthUsersState,
  binding: { channel: string; accountId?: string },
) {
  const current = parseAllowedChannelsText(state.authUsersForm.allowedChannelsText);
  const next = current.filter(
    (entry) =>
      !(entry.channel === binding.channel && (entry.accountId ?? "") === (binding.accountId ?? "")),
  );
  state.authUsersForm = {
    ...state.authUsersForm,
    allowedChannelsText: formatAllowedChannelsText(next),
  };
  validateAuthUsersAllowedChannels(state);
}

export async function saveAuthUser(state: AuthUsersState): Promise<boolean> {
  if (!ensureAdmin(state)) {
    return false;
  }
  state.authUsersSaving = true;
  state.authUsersError = null;
  try {
    const body = {
      action: "upsert",
      username: state.authUsersForm.username.trim(),
      role: state.authUsersForm.role,
      agentId: state.authUsersForm.agentId.trim(),
      workspace: state.authUsersForm.workspace.trim(),
      agentDir: state.authUsersForm.agentDir.trim(),
      mainSessionKey: state.authUsersForm.mainSessionKey.trim(),
      passwordHash: state.authUsersForm.passwordHash.trim(),
      password: state.authUsersForm.password,
      disabled: state.authUsersForm.disabled,
      allowedChannels: parseAllowedChannelsText(state.authUsersForm.allowedChannelsText),
    };
    const res = await fetch(authEndpoint(state.basePath), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || payload.ok !== true) {
      state.authUsersError = payload.error || `save user failed (${res.status})`;
      return false;
    }
    await loadAuthUsers(state);
    if (body.username) {
      selectAuthUser(state, body.username);
    }
    return true;
  } catch (error) {
    state.authUsersError = String(error);
    return false;
  } finally {
    state.authUsersSaving = false;
  }
}

export async function updateAuthUsersAgentModel(
  state: AuthUsersState,
  agentId?: string,
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const resolvedAgentId = (agentId ?? state.authUsersForm.agentId).trim();
  const model = state.authUsersForm.agentModel.trim();
  if (!resolvedAgentId || !model) {
    return true;
  }
  try {
    await state.client.request("agents.update", {
      agentId: resolvedAgentId,
      model,
    });
    return true;
  } catch (error) {
    state.authUsersError = `set agent model failed: ${String(error)}`;
    return false;
  }
}

export async function deleteAuthUser(state: AuthUsersState) {
  if (!ensureAdmin(state)) {
    return;
  }
  const username = state.authUsersForm.username.trim();
  if (!username) {
    state.authUsersError = "username required";
    return;
  }
  state.authUsersDeleting = true;
  state.authUsersError = null;
  try {
    const res = await fetch(authEndpoint(state.basePath), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "delete", username }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || payload.ok !== true) {
      state.authUsersError = payload.error || `delete user failed (${res.status})`;
      return;
    }
    await loadAuthUsers(state);
    selectAuthUser(state, null);
  } catch (error) {
    state.authUsersError = String(error);
  } finally {
    state.authUsersDeleting = false;
  }
}

export async function bootstrapAuthUserAgent(
  state: AuthUsersState,
  username?: string,
): Promise<boolean> {
  if (!ensureAdmin(state)) {
    return false;
  }
  const resolvedUsername = (username ?? state.authUsersForm.username).trim();
  if (!resolvedUsername) {
    state.authUsersBootstrapError = "username required";
    return false;
  }
  state.authUsersBootstrapBusy = true;
  state.authUsersBootstrapError = null;
  try {
    const res = await fetch(authEndpoint(state.basePath), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "bootstrap-agent", username: resolvedUsername }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || payload.ok !== true) {
      state.authUsersBootstrapError =
        payload.error || `bootstrap user agent failed (${res.status})`;
      return false;
    }
    await loadAuthUsers(state);
    selectAuthUser(state, resolvedUsername);
    return true;
  } catch (error) {
    state.authUsersBootstrapError = String(error);
    return false;
  } finally {
    state.authUsersBootstrapBusy = false;
  }
}
