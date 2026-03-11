import { describe, expect, it, vi } from "vitest";

vi.mock("../i18n/index.ts", () => ({
  t: (key: string) => key,
}));

import { isTabAllowedForRole, resolveVisibleTabGroups } from "./navigation.ts";

describe("navigation role guards", () => {
  it("allows all tabs for admin or missing role", () => {
    expect(isTabAllowedForRole("config", "admin")).toBe(true);
    expect(isTabAllowedForRole("config", null)).toBe(true);
    expect(isTabAllowedForRole("debug", undefined)).toBe(true);
  });

  it("restricts non-admin tabs for user role", () => {
    expect(isTabAllowedForRole("chat", "user")).toBe(true);
    expect(isTabAllowedForRole("channels", "user")).toBe(true);
    expect(isTabAllowedForRole("sessions", "user")).toBe(true);
    expect(isTabAllowedForRole("usage", "user")).toBe(true);

    expect(isTabAllowedForRole("overview", "user")).toBe(false);
    expect(isTabAllowedForRole("cron", "user")).toBe(false);
    expect(isTabAllowedForRole("agents", "user")).toBe(false);
    expect(isTabAllowedForRole("skills", "user")).toBe(false);
    expect(isTabAllowedForRole("nodes", "user")).toBe(false);
    expect(isTabAllowedForRole("users", "user")).toBe(false);
    expect(isTabAllowedForRole("onboarding", "user")).toBe(false);
    expect(isTabAllowedForRole("config", "user")).toBe(false);
    expect(isTabAllowedForRole("debug", "user")).toBe(false);
    expect(isTabAllowedForRole("logs", "user")).toBe(false);
  });

  it("returns only allowed groups for user role", () => {
    const groups = resolveVisibleTabGroups("user");
    const tabs = groups.flatMap((group) => group.tabs);
    expect(tabs).toEqual(["chat", "channels", "sessions", "usage"]);
  });

  it("keeps full groups for admin role", () => {
    const groups = resolveVisibleTabGroups("admin");
    const tabs = new Set(groups.flatMap((group) => group.tabs));
    expect(tabs.has("chat")).toBe(true);
    expect(tabs.has("config")).toBe(true);
    expect(tabs.has("debug")).toBe(true);
    expect(tabs.has("logs")).toBe(true);
  });
});
