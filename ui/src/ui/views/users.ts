import { html, nothing } from "lit";
import { buildAgentMainSessionKey } from "../../../../src/routing/session-key.js";
import type { AppViewState } from "../app-view-state.ts";
import {
  addAuthUsersAllowedChannelBinding,
  bootstrapAuthUserAgent,
  cancelAuthUsersCreateAgent,
  chooseAuthUsersAgent,
  createAuthUsersAgent,
  deleteAuthUser,
  loadAuthUsers,
  openAuthUsersCreateAgent,
  removeAuthUsersAllowedChannelBinding,
  saveAuthUser,
  selectAuthUser,
  updateAuthUsersAgentModel,
  validateAuthUsersAllowedChannels,
} from "../controllers/auth-users.ts";

function setWizardStep(state: AppViewState, step: 1 | 2 | 3 | 4 | 5) {
  state.authUsersWizardStep = step;
}

function parseBindings(raw: string): Array<{ channel: string; accountId?: string }> {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [channelRaw, accountIdRaw] = line.split(":");
      return {
        channel: (channelRaw ?? "").trim().toLowerCase(),
        accountId: (accountIdRaw ?? "").trim() || undefined,
      };
    })
    .filter((entry) => entry.channel);
}

function extractModelSuggestions(state: AppViewState): string[] {
  const out = new Set<string>();
  const source =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null) ?? null;
  if (!source || typeof source !== "object") {
    return [];
  }
  const root = source as {
    agents?: {
      defaults?: {
        model?: unknown;
        models?: unknown;
      };
      list?: unknown[];
    };
  };
  const defaultModel = root.agents?.defaults?.model;
  if (typeof defaultModel === "string" && defaultModel.trim()) {
    out.add(defaultModel.trim());
  } else if (defaultModel && typeof defaultModel === "object" && !Array.isArray(defaultModel)) {
    const primary = (defaultModel as { primary?: unknown }).primary;
    if (typeof primary === "string" && primary.trim()) {
      out.add(primary.trim());
    }
    const fallbacks = (defaultModel as { fallbacks?: unknown }).fallbacks;
    if (Array.isArray(fallbacks)) {
      for (const entry of fallbacks) {
        if (typeof entry === "string" && entry.trim()) {
          out.add(entry.trim());
        }
      }
    }
  }
  const models = root.agents?.defaults?.models;
  if (Array.isArray(models)) {
    for (const entry of models) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string" && id.trim()) {
        out.add(id.trim());
      }
    }
  }
  const list = root.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const model = (entry as { model?: unknown }).model;
      if (typeof model === "string" && model.trim()) {
        out.add(model.trim());
      } else if (model && typeof model === "object" && !Array.isArray(model)) {
        const primary = (model as { primary?: unknown }).primary;
        if (typeof primary === "string" && primary.trim()) {
          out.add(primary.trim());
        }
      }
    }
  }
  return Array.from(out.values());
}

function renderAccountStep(state: AppViewState) {
  return html`
    <div class="users-step-card">
      <h4>Account</h4>
      <div class="form-grid">
        <label class="field">
          <span>Username</span>
          <input
            .value=${state.authUsersForm.username}
            @input=${(event: Event) =>
              (state.authUsersForm = {
                ...state.authUsersForm,
                username: (event.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="field">
          <span>Role</span>
          <select
            .value=${state.authUsersForm.role}
            @change=${(event: Event) =>
              (state.authUsersForm = {
                ...state.authUsersForm,
                role: (event.target as HTMLSelectElement).value as "admin" | "user",
              })}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label class="field full">
          <span>Password (plain text)</span>
          <input
            type="password"
            .value=${state.authUsersForm.password}
            @input=${(event: Event) =>
              (state.authUsersForm = {
                ...state.authUsersForm,
                password: (event.target as HTMLInputElement).value,
              })}
          />
        </label>
      </div>
    </div>
  `;
}

function renderAgentStep(state: AppViewState) {
  const agents = state.agentsList?.agents ?? [];
  const resolvedAgentId = state.authUsersForm.agentId.trim().toLowerCase();
  const resolvedMainKey = state.authUsersForm.mainSessionKey.trim() || "main";
  const previewSessionKey = resolvedAgentId
    ? buildAgentMainSessionKey({ agentId: resolvedAgentId, mainKey: resolvedMainKey })
    : "";
  return html`
    <div class="users-step-card">
      <h4>Agent</h4>
      <div class="field full">
        <span>Select Existing Agent</span>
        <div class="users-chip-row">
          ${
            agents.length === 0
              ? html`
                  <span class="page-sub">No agents loaded yet.</span>
                `
              : agents.map((agent) => {
                  const id = typeof agent.id === "string" ? agent.id : "";
                  const label =
                    typeof agent.name === "string" && agent.name.trim()
                      ? `${agent.name} (${id})`
                      : id;
                  return html`
                    <button
                      class="btn btn--sm ${resolvedAgentId === id ? "primary" : ""}"
                      @click=${() => chooseAuthUsersAgent(state, id)}
                    >
                      ${label}
                    </button>
                  `;
                })
          }
        </div>
        <div class="row" style="margin-top:8px;">
          <button class="btn btn--sm" @click=${() => openAuthUsersCreateAgent(state)}>
            + Create New Agent
          </button>
        </div>
      </div>
      ${
        state.authUsersCreateAgentOpen
          ? html`
              <div class="users-create-agent">
                <div class="card-subtitle">Create Agent</div>
                ${
                  state.authUsersCreateAgentError
                    ? html`<div class="callout danger">${state.authUsersCreateAgentError}</div>`
                    : nothing
                }
                <div class="form-grid">
                  <label class="field">
                    <span>Name</span>
                    <input
                      .value=${state.authUsersCreateAgentForm.name}
                      @input=${(event: Event) =>
                        (state.authUsersCreateAgentForm = {
                          ...state.authUsersCreateAgentForm,
                          name: (event.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field">
                    <span>Workspace</span>
                    <input
                      .value=${state.authUsersCreateAgentForm.workspace}
                      @input=${(event: Event) =>
                        (state.authUsersCreateAgentForm = {
                          ...state.authUsersCreateAgentForm,
                          workspace: (event.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field">
                    <span>Model (optional)</span>
                    <input
                      .value=${state.authUsersCreateAgentForm.model}
                      @input=${(event: Event) =>
                        (state.authUsersCreateAgentForm = {
                          ...state.authUsersCreateAgentForm,
                          model: (event.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <div class="row" style="gap:8px;">
                    <button
                      class="btn primary"
                      ?disabled=${state.authUsersCreateAgentBusy}
                      @click=${() => void createAuthUsersAgent(state)}
                    >
                      ${state.authUsersCreateAgentBusy ? "Creating..." : "Create"}
                    </button>
                    <button
                      class="btn"
                      ?disabled=${state.authUsersCreateAgentBusy}
                      @click=${() => cancelAuthUsersCreateAgent(state)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            `
          : nothing
      }
      <div class="form-grid">
        <label class="field">
          <span>Agent ID</span>
          <input
            .value=${state.authUsersForm.agentId}
            @input=${(event: Event) => {
              state.authUsersForm = {
                ...state.authUsersForm,
                agentId: (event.target as HTMLInputElement).value,
              };
              validateAuthUsersAllowedChannels(state);
            }}
          />
        </label>
        <label class="field">
          <span>Main Session Key</span>
          <input
            .value=${state.authUsersForm.mainSessionKey}
            @input=${(event: Event) =>
              (state.authUsersForm = {
                ...state.authUsersForm,
                mainSessionKey: (event.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="field">
          <span>Workspace (optional)</span>
          <input
            .value=${state.authUsersForm.workspace}
            @input=${(event: Event) =>
              (state.authUsersForm = {
                ...state.authUsersForm,
                workspace: (event.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="field">
          <span>Agent Dir (optional)</span>
          <input
            .value=${state.authUsersForm.agentDir}
            @input=${(event: Event) =>
              (state.authUsersForm = {
                ...state.authUsersForm,
                agentDir: (event.target as HTMLInputElement).value,
              })}
          />
        </label>
        <div class="field full">
          <span>Session Preview</span>
          <div class="page-sub mono">${previewSessionKey || "agent:<agentId>:<mainSessionKey>"}</div>
        </div>
      </div>
    </div>
  `;
}

function renderModelStep(state: AppViewState) {
  const suggestions = extractModelSuggestions(state);
  return html`
    <div class="users-step-card">
      <h4>Model</h4>
      <div class="form-grid">
        <label class="field full">
          <span>Agent Model</span>
          <input
            .value=${state.authUsersForm.agentModel}
            list="users-agent-model-suggestions"
            placeholder="openai/gpt-5"
            @input=${(event: Event) =>
              (state.authUsersForm = {
                ...state.authUsersForm,
                agentModel: (event.target as HTMLInputElement).value,
              })}
          />
          <datalist id="users-agent-model-suggestions">
            ${suggestions.map((entry) => html`<option value=${entry}></option>`)}
          </datalist>
        </label>
      </div>
      <div class="page-sub">
        If left empty, this agent uses global default model from <span class="mono">agents.defaults.model</span>.
      </div>
    </div>
  `;
}

function renderChannelsStep(state: AppViewState) {
  const bindings = parseBindings(state.authUsersForm.allowedChannelsText);
  const channelAccounts = state.channelsSnapshot?.channelAccounts ?? {};
  const channelOrder =
    state.channelsSnapshot?.channelOrder?.filter((entry) => Boolean(channelAccounts[entry])) ??
    Object.keys(channelAccounts);
  const selectedChannel = state.authUsersChannelDraftChannel.trim().toLowerCase();
  const selectedAccounts = selectedChannel ? (channelAccounts[selectedChannel] ?? []) : [];

  return html`
    <div class="users-step-card">
      <h4>Channel Bindings</h4>
      <div class="form-grid">
        <label class="field">
          <span>Channel</span>
          <select
            .value=${state.authUsersChannelDraftChannel}
            @change=${(event: Event) => {
              state.authUsersChannelDraftChannel = (event.target as HTMLSelectElement).value;
              state.authUsersChannelDraftAccountId = "";
            }}
          >
            <option value="">Select channel</option>
            ${channelOrder.map((channel) => html`<option value=${channel}>${channel}</option>`)}
          </select>
        </label>
        <label class="field">
          <span>Account</span>
          <select
            .value=${state.authUsersChannelDraftAccountId}
            @change=${(event: Event) =>
              (state.authUsersChannelDraftAccountId = (event.target as HTMLSelectElement).value)}
          >
            <option value="">Any account in channel</option>
            ${selectedAccounts.map((account) => {
              const accountId = typeof account.accountId === "string" ? account.accountId : "";
              const name = typeof account.name === "string" ? account.name : "";
              const status = account.connected ?? account.running ?? account.enabled;
              const suffix = status === false ? " (offline)" : status === true ? " (online)" : "";
              const label =
                name && name !== accountId
                  ? `${name} (${accountId})${suffix}`
                  : `${accountId}${suffix}`;
              return html`<option value=${accountId}>${label}</option>`;
            })}
          </select>
        </label>
        <div class="row" style="gap:8px;">
          <button
            class="btn btn--sm"
            ?disabled=${!state.authUsersChannelDraftChannel}
            @click=${() => addAuthUsersAllowedChannelBinding(state)}
          >
            Add Binding
          </button>
        </div>
      </div>
      <div class="list" style="margin-top:8px;">
        ${
          bindings.length === 0
            ? html`
                <div class="page-sub">No bindings configured yet.</div>
              `
            : bindings.map((binding) => {
                const accounts = channelAccounts[binding.channel] ?? [];
                const matched = binding.accountId
                  ? accounts.find((entry) => entry.accountId === binding.accountId)
                  : null;
                const status = matched
                  ? (matched.connected ?? matched.running ?? matched.enabled)
                  : undefined;
                const statusLabel =
                  status === true ? "online" : status === false ? "offline" : "unknown";
                return html`
                  <div class="list-item">
                    <span class="mono">${binding.channel}${binding.accountId ? `:${binding.accountId}` : ""}</span>
                    <span class="pill">${statusLabel}</span>
                    <button
                      class="btn btn--sm danger"
                      @click=${() => removeAuthUsersAllowedChannelBinding(state, binding)}
                    >
                      Remove
                    </button>
                  </div>
                `;
              })
        }
      </div>
      <label class="field full">
        <span>Raw Bindings (advanced)</span>
        <textarea
          .value=${state.authUsersForm.allowedChannelsText}
          @input=${(event: Event) => {
            state.authUsersForm = {
              ...state.authUsersForm,
              allowedChannelsText: (event.target as HTMLTextAreaElement).value,
            };
            validateAuthUsersAllowedChannels(state);
          }}
        ></textarea>
      </label>
      ${
        state.authUsersChannelWarnings.length > 0
          ? html`
              <div class="callout warn">
                ${state.authUsersChannelWarnings.map((entry) => html`<div>${entry}</div>`)}
              </div>
            `
          : html`
              <div class="callout">Channel/account bindings look valid against current gateway snapshot.</div>
            `
      }
    </div>
  `;
}

function renderReviewStep(state: AppViewState) {
  return html`
    <div class="users-step-card">
      <h4>Review</h4>
      <div class="page-sub">
        <div><strong>Username:</strong> <span class="mono">${state.authUsersForm.username}</span></div>
        <div><strong>Role:</strong> <span class="mono">${state.authUsersForm.role}</span></div>
        <div><strong>Agent:</strong> <span class="mono">${state.authUsersForm.agentId}</span></div>
        <div><strong>Main Session:</strong> <span class="mono">${state.authUsersForm.mainSessionKey || "main"}</span></div>
        <div><strong>Model:</strong> <span class="mono">${state.authUsersForm.agentModel || "(global default)"}</span></div>
      </div>
      <label class="field checkbox">
        <span>Auto bootstrap agent workspace/config after create</span>
        <input
          type="checkbox"
          .checked=${state.authUsersAutoBootstrap}
          @change=${(event: Event) => (state.authUsersAutoBootstrap = (event.target as HTMLInputElement).checked)}
        />
      </label>
      <label class="field checkbox">
        <span>Disabled</span>
        <input
          type="checkbox"
          .checked=${state.authUsersForm.disabled}
          @change=${(event: Event) =>
            (state.authUsersForm = {
              ...state.authUsersForm,
              disabled: (event.target as HTMLInputElement).checked,
            })}
        />
      </label>
    </div>
  `;
}

export function renderUsers(state: AppViewState) {
  if (state.authViewer?.role !== "admin") {
    return html`
      <section class="card"><div class="callout danger">Admin access required.</div></section>
    `;
  }
  const creating = !state.authUsersSelected;
  const step = state.authUsersWizardStep;
  const steps = ["Account", "Agent", "Model", "Channels", "Review"];

  return html`
    <section class="card users-shell">
      <div class="card-head">
        <h3 class="card-title">Local Users</h3>
        <div class="row" style="gap:8px;">
          <button class="btn btn--sm" @click=${() => loadAuthUsers(state)}>
            ${state.authUsersLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      ${state.authUsersDbPath ? html`<div class="page-sub mono">DB: ${state.authUsersDbPath}</div>` : nothing}
      ${state.authUsersError ? html`<div class="callout danger">${state.authUsersError}</div>` : nothing}
      ${state.authUsersBootstrapError ? html`<div class="callout danger">${state.authUsersBootstrapError}</div>` : nothing}

      <div class="users-layout">
        <aside class="users-sidebar">
          <div class="card-subtitle" style="margin-bottom:8px;">Users</div>
          <div class="list">
            <button class="btn btn--sm" @click=${() => selectAuthUser(state, null)}>+ New User</button>
            ${state.authUsersList.map(
              (entry) => html`<button
                class="list-item ${state.authUsersSelected === entry.username ? "active" : ""}"
                @click=${() => selectAuthUser(state, entry.username)}
              >
                <span class="mono">${entry.username}</span>
                <span class="pill">${entry.role}</span>
                ${
                  entry.disabled
                    ? html`
                        <span class="pill danger">disabled</span>
                      `
                    : nothing
                }
              </button>`,
            )}
          </div>
        </aside>

        <div class="users-main">
          <div class="card-subtitle">${creating ? "New User Wizard" : "User Editor"}</div>
          ${
            creating
              ? html`
                  <div class="users-stepper">
                    ${steps.map(
                      (label, index) =>
                        html`<button
                          class="users-stepper__item ${step === index + 1 ? "is-active" : ""}"
                          @click=${() => setWizardStep(state, (index + 1) as 1 | 2 | 3 | 4 | 5)}
                        >
                          ${index + 1}. ${label}
                        </button>`,
                    )}
                  </div>
                `
              : nothing
          }

          ${creating && step === 1 ? renderAccountStep(state) : nothing}
          ${creating && step === 2 ? renderAgentStep(state) : nothing}
          ${creating && step === 3 ? renderModelStep(state) : nothing}
          ${creating && step === 4 ? renderChannelsStep(state) : nothing}
          ${creating && step === 5 ? renderReviewStep(state) : nothing}

          ${
            !creating
              ? html`
                  <div class="users-step-card">
                    ${renderAccountStep(state)}
                    ${renderAgentStep(state)}
                    ${renderModelStep(state)}
                    ${renderChannelsStep(state)}
                    <label class="field checkbox">
                      <span>Disabled</span>
                      <input
                        type="checkbox"
                        .checked=${state.authUsersForm.disabled}
                        @change=${(event: Event) =>
                          (state.authUsersForm = {
                            ...state.authUsersForm,
                            disabled: (event.target as HTMLInputElement).checked,
                          })}
                      />
                    </label>
                  </div>
                `
              : nothing
          }

          <div class="row" style="gap:8px; margin-top: 12px;">
            ${
              creating
                ? html`
                    <button
                      class="btn"
                      ?disabled=${step === 1}
                      @click=${() =>
                        setWizardStep(state, Math.max(1, step - 1) as 1 | 2 | 3 | 4 | 5)}
                    >
                      Back
                    </button>
                    ${
                      step < 5
                        ? html`
                            <button
                              class="btn primary"
                              @click=${() =>
                                setWizardStep(state, Math.min(5, step + 1) as 1 | 2 | 3 | 4 | 5)}
                            >
                              Next
                            </button>
                          `
                        : html`
                            <button
                              class="btn primary"
                              ?disabled=${state.authUsersSaving || state.authUsersBootstrapBusy}
                              @click=${async () => {
                                const ok = await saveAuthUser(state);
                                if (!ok) {
                                  return;
                                }
                                const modelOk = await updateAuthUsersAgentModel(state);
                                if (!modelOk) {
                                  return;
                                }
                                if (state.authUsersAutoBootstrap) {
                                  await bootstrapAuthUserAgent(state, state.authUsersForm.username);
                                }
                              }}
                            >
                              ${state.authUsersSaving ? "Creating..." : "Create User"}
                            </button>
                          `
                    }
                  `
                : html`
                    <button
                      class="btn primary"
                      ?disabled=${state.authUsersSaving}
                      @click=${async () => {
                        const ok = await saveAuthUser(state);
                        if (!ok) {
                          return;
                        }
                        await updateAuthUsersAgentModel(state);
                      }}
                    >
                      ${state.authUsersSaving ? "Saving..." : "Save User"}
                    </button>
                    <button
                      class="btn"
                      ?disabled=${state.authUsersBootstrapBusy || !state.authUsersForm.username.trim()}
                      @click=${() => void bootstrapAuthUserAgent(state)}
                    >
                      ${state.authUsersBootstrapBusy ? "Bootstrapping..." : "Bootstrap Agent"}
                    </button>
                    <button
                      class="btn danger"
                      ?disabled=${state.authUsersDeleting || !state.authUsersForm.username.trim()}
                      @click=${() => deleteAuthUser(state)}
                    >
                      ${state.authUsersDeleting ? "Deleting..." : "Delete User"}
                    </button>
                  `
            }
          </div>
        </div>
      </div>
    </section>
  `;
}
