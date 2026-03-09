import { GatewayRequestError, type GatewayBrowserClient } from "../gateway.ts";

export type WizardRunStatus = "running" | "done" | "cancelled" | "error";

export type WizardStepOption = {
  value: unknown;
  label: string;
  hint?: string;
};

export type WizardStep = {
  id: string;
  type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action";
  title?: string;
  message?: string;
  options?: WizardStepOption[];
  initialValue?: unknown;
  placeholder?: string;
  sensitive?: boolean;
  executor?: "gateway" | "client";
};

type WizardStartResult = {
  sessionId: string;
  done: boolean;
  step?: WizardStep;
  status?: WizardRunStatus;
  error?: string;
};

type WizardNextResult = {
  done: boolean;
  step?: WizardStep;
  status?: WizardRunStatus;
  error?: string;
};

type WizardStatusResult = {
  status: WizardRunStatus;
  error?: string;
};

export type OnboardingWizardState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  onboardingWizardSessionId: string | null;
  onboardingWizardStep: WizardStep | null;
  onboardingWizardStatus: "idle" | WizardRunStatus;
  onboardingWizardError: string | null;
  onboardingWizardBusy: boolean;
  onboardingWizardDraft: unknown;
  onboardingWizardDraftStepId: string | null;
};

function stepOptions(step: WizardStep): WizardStepOption[] {
  return Array.isArray(step.options) ? step.options : [];
}

function findOptionIndex(options: WizardStepOption[], value: unknown): number {
  const byIdentity = options.findIndex((entry) => Object.is(entry.value, value));
  if (byIdentity >= 0) {
    return byIdentity;
  }
  const encoded = JSON.stringify(value);
  return options.findIndex((entry) => JSON.stringify(entry.value) === encoded);
}

function resolveInitialDraft(step: WizardStep): unknown {
  const initial = step.initialValue;
  if (step.type === "text") {
    return typeof initial === "string" ? initial : "";
  }
  if (step.type === "confirm") {
    return Boolean(initial);
  }
  if (step.type === "select") {
    const options = stepOptions(step);
    const idx = findOptionIndex(options, initial);
    return idx >= 0 ? idx : options.length > 0 ? 0 : null;
  }
  if (step.type === "multiselect") {
    const options = stepOptions(step);
    const selected = Array.isArray(initial) ? initial : [];
    const indexes = selected
      .map((value) => findOptionIndex(options, value))
      .filter((idx): idx is number => idx >= 0);
    return indexes;
  }
  return initial ?? null;
}

function resolveAnswerValue(step: WizardStep, draft: unknown): unknown {
  if (step.type === "text") {
    return typeof draft === "string" ? draft : "";
  }
  if (step.type === "confirm") {
    return Boolean(draft);
  }
  if (step.type === "select") {
    const options = stepOptions(step);
    const idx = typeof draft === "number" ? draft : -1;
    return idx >= 0 && idx < options.length ? options[idx]?.value : undefined;
  }
  if (step.type === "multiselect") {
    const options = stepOptions(step);
    const indexes = Array.isArray(draft) ? draft : [];
    return indexes
      .map((idx) => (typeof idx === "number" && idx >= 0 && idx < options.length ? idx : -1))
      .filter((idx): idx is number => idx >= 0)
      .map((idx) => options[idx]?.value);
  }
  return draft;
}

function applyResult(
  state: OnboardingWizardState,
  sessionId: string | null,
  result: { done: boolean; step?: WizardStep; status?: WizardRunStatus; error?: string },
) {
  state.onboardingWizardSessionId = sessionId;
  state.onboardingWizardError = result.error ?? null;
  if (result.step) {
    state.onboardingWizardStep = result.step;
    state.onboardingWizardStatus = "running";
    state.onboardingWizardDraftStepId = result.step.id;
    state.onboardingWizardDraft = resolveInitialDraft(result.step);
    return;
  }
  state.onboardingWizardStep = null;
  state.onboardingWizardDraftStepId = null;
  state.onboardingWizardDraft = null;
  state.onboardingWizardStatus = result.status ?? (result.done ? "done" : "idle");
  if (state.onboardingWizardStatus !== "running") {
    state.onboardingWizardSessionId = null;
  }
}

function formatWizardError(error: unknown): string {
  if (error instanceof GatewayRequestError) {
    return `${error.message} (${error.gatewayCode})`;
  }
  return String(error);
}

export async function startOnboardingWizard(state: OnboardingWizardState) {
  if (!state.client || !state.connected || state.onboardingWizardBusy) {
    return;
  }
  state.onboardingWizardBusy = true;
  state.onboardingWizardError = null;
  try {
    const result = await state.client.request<WizardStartResult>("wizard.start", { mode: "local" });
    applyResult(state, result.sessionId, result);
  } catch (error) {
    state.onboardingWizardError = formatWizardError(error);
  } finally {
    state.onboardingWizardBusy = false;
  }
}

export async function continueOnboardingWizard(state: OnboardingWizardState) {
  if (
    !state.client ||
    !state.connected ||
    state.onboardingWizardBusy ||
    !state.onboardingWizardSessionId
  ) {
    return;
  }
  state.onboardingWizardBusy = true;
  state.onboardingWizardError = null;
  try {
    const result = await state.client.request<WizardNextResult>("wizard.next", {
      sessionId: state.onboardingWizardSessionId,
    });
    applyResult(state, state.onboardingWizardSessionId, result);
  } catch (error) {
    state.onboardingWizardError = formatWizardError(error);
  } finally {
    state.onboardingWizardBusy = false;
  }
}

export async function submitOnboardingWizardAnswer(state: OnboardingWizardState) {
  const step = state.onboardingWizardStep;
  if (
    !state.client ||
    !state.connected ||
    state.onboardingWizardBusy ||
    !state.onboardingWizardSessionId ||
    !step
  ) {
    return;
  }
  state.onboardingWizardBusy = true;
  state.onboardingWizardError = null;
  try {
    const result = await state.client.request<WizardNextResult>("wizard.next", {
      sessionId: state.onboardingWizardSessionId,
      answer: {
        stepId: step.id,
        value: resolveAnswerValue(step, state.onboardingWizardDraft),
      },
    });
    applyResult(state, state.onboardingWizardSessionId, result);
  } catch (error) {
    state.onboardingWizardError = formatWizardError(error);
  } finally {
    state.onboardingWizardBusy = false;
  }
}

export async function cancelOnboardingWizard(state: OnboardingWizardState) {
  if (
    !state.client ||
    !state.connected ||
    state.onboardingWizardBusy ||
    !state.onboardingWizardSessionId
  ) {
    return;
  }
  state.onboardingWizardBusy = true;
  state.onboardingWizardError = null;
  try {
    const result = await state.client.request<WizardStatusResult>("wizard.cancel", {
      sessionId: state.onboardingWizardSessionId,
    });
    state.onboardingWizardStatus = result.status;
    state.onboardingWizardError = result.error ?? null;
    state.onboardingWizardSessionId = null;
    state.onboardingWizardStep = null;
    state.onboardingWizardDraft = null;
    state.onboardingWizardDraftStepId = null;
  } catch (error) {
    state.onboardingWizardError = formatWizardError(error);
  } finally {
    state.onboardingWizardBusy = false;
  }
}

export async function refreshOnboardingWizard(state: OnboardingWizardState) {
  if (
    !state.client ||
    !state.connected ||
    !state.onboardingWizardSessionId ||
    state.onboardingWizardBusy
  ) {
    return;
  }
  try {
    const result = await state.client.request<WizardStatusResult>("wizard.status", {
      sessionId: state.onboardingWizardSessionId,
    });
    state.onboardingWizardStatus = result.status;
    state.onboardingWizardError = result.error ?? null;
    if (result.status !== "running") {
      state.onboardingWizardSessionId = null;
      state.onboardingWizardStep = null;
      state.onboardingWizardDraft = null;
      state.onboardingWizardDraftStepId = null;
    }
  } catch (error) {
    if (error instanceof GatewayRequestError && error.gatewayCode === "invalid_request") {
      state.onboardingWizardStatus = "idle";
      state.onboardingWizardSessionId = null;
      state.onboardingWizardStep = null;
      state.onboardingWizardDraft = null;
      state.onboardingWizardDraftStepId = null;
      return;
    }
    state.onboardingWizardError = formatWizardError(error);
  }
}
