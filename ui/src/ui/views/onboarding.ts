import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import {
  cancelOnboardingWizard,
  continueOnboardingWizard,
  startOnboardingWizard,
  submitOnboardingWizardAnswer,
  type WizardStep,
} from "../controllers/onboarding-wizard.ts";

function renderStepInput(state: AppViewState, step: WizardStep) {
  const options = Array.isArray(step.options) ? step.options : [];
  if (step.type === "text") {
    return html`
      <label class="field full">
        <span>Value</span>
        <input
          type=${step.sensitive ? "password" : "text"}
          .placeholder=${step.placeholder ?? ""}
          .value=${typeof state.onboardingWizardDraft === "string" ? state.onboardingWizardDraft : ""}
          @input=${(event: Event) => {
            state.onboardingWizardDraft = (event.target as HTMLInputElement).value;
          }}
        />
      </label>
    `;
  }
  if (step.type === "confirm") {
    return html`
      <label class="field checkbox">
        <span>Confirm</span>
        <input
          type="checkbox"
          .checked=${Boolean(state.onboardingWizardDraft)}
          @change=${(event: Event) => {
            state.onboardingWizardDraft = (event.target as HTMLInputElement).checked;
          }}
        />
      </label>
    `;
  }
  if (step.type === "select") {
    const selectedIndex =
      typeof state.onboardingWizardDraft === "number" ? state.onboardingWizardDraft : -1;
    return html`
      <label class="field full">
        <span>Options</span>
        <select
          .value=${selectedIndex >= 0 ? String(selectedIndex) : ""}
          @change=${(event: Event) => {
            const raw = (event.target as HTMLSelectElement).value;
            state.onboardingWizardDraft = Number.parseInt(raw, 10);
          }}
        >
          <option value="" disabled>Select one option</option>
          ${options.map(
            (option, index) =>
              html`<option value=${String(index)}>${option.label}${option.hint ? ` - ${option.hint}` : ""}</option>`,
          )}
        </select>
      </label>
    `;
  }
  if (step.type === "multiselect") {
    const selected = new Set(
      Array.isArray(state.onboardingWizardDraft)
        ? state.onboardingWizardDraft.filter((value): value is number => typeof value === "number")
        : [],
    );
    return html`
      <div class="field full">
        <span>Options</span>
        <div class="list">
          ${options.map(
            (option, index) => html`
              <label class="field checkbox">
                <span>${option.label}${option.hint ? ` - ${option.hint}` : ""}</span>
                <input
                  type="checkbox"
                  .checked=${selected.has(index)}
                  @change=${(event: Event) => {
                    const next = new Set(selected);
                    const checked = (event.target as HTMLInputElement).checked;
                    if (checked) {
                      next.add(index);
                    } else {
                      next.delete(index);
                    }
                    state.onboardingWizardDraft = Array.from(next.values()).toSorted(
                      (a, b) => a - b,
                    );
                  }}
                />
              </label>
            `,
          )}
        </div>
      </div>
    `;
  }
  return nothing;
}

function resolveStepActionLabel(step: WizardStep): string {
  if (step.type === "action") {
    return "Run action";
  }
  if (step.type === "note" || step.type === "progress") {
    return "Continue";
  }
  return "Submit";
}

export function renderOnboarding(state: AppViewState) {
  if (state.authViewer?.role !== "admin") {
    return html`
      <section class="card"><div class="callout danger">Admin access required.</div></section>
    `;
  }
  const step = state.onboardingWizardStep;
  const running = state.onboardingWizardStatus === "running";
  return html`
    <section class="card">
      <div class="card-head">
        <h3 class="card-title">Setup Wizard</h3>
        <div class="row" style="gap: 8px;">
          <button
            class="btn btn--sm"
            ?disabled=${state.onboardingWizardBusy}
            @click=${() => void startOnboardingWizard(state)}
          >
            ${state.onboardingWizardBusy ? "Starting..." : "Start wizard"}
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${state.onboardingWizardBusy || !running || !state.onboardingWizardSessionId}
            @click=${() => void continueOnboardingWizard(state)}
          >
            Continue
          </button>
          <button
            class="btn btn--sm danger"
            ?disabled=${state.onboardingWizardBusy || !running || !state.onboardingWizardSessionId}
            @click=${() => void cancelOnboardingWizard(state)}
          >
            Cancel
          </button>
        </div>
      </div>
      <div class="page-sub">
        Status: <span class="mono">${state.onboardingWizardStatus}</span>
        ${
          state.onboardingWizardSessionId
            ? html` | Session: <span class="mono">${state.onboardingWizardSessionId}</span>`
            : nothing
        }
      </div>
      ${state.onboardingWizardError ? html`<div class="callout danger">${state.onboardingWizardError}</div>` : nothing}

      ${
        !step
          ? html`
              <div class="callout">Start the setup wizard to configure gateway onboarding interactively.</div>
            `
          : html`
              <div class="form-grid" style="margin-top: 16px;">
                <div class="card-subtitle">${step.title || step.id}</div>
                ${step.message ? html`<div class="page-sub">${step.message}</div>` : nothing}
                ${step.executor ? html`<div class="page-sub">Executor: ${step.executor}</div>` : nothing}
                ${renderStepInput(state, step)}
                <div class="row" style="gap: 8px;">
                  <button
                    class="btn primary"
                    ?disabled=${state.onboardingWizardBusy}
                    @click=${() => void submitOnboardingWizardAnswer(state)}
                  >
                    ${state.onboardingWizardBusy ? "Submitting..." : resolveStepActionLabel(step)}
                  </button>
                </div>
              </div>
            `
      }
    </section>
  `;
}
