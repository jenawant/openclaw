import { describe, expect, it, vi } from "vitest";
import { maybeSeedControlUiLocalAuthAtStartup } from "./startup-control-ui-local-auth.js";

describe("maybeSeedControlUiLocalAuthAtStartup", () => {
  it("does nothing when OPENCLAW_LOCALAUTH_ENABLE is not set", async () => {
    const writeConfig = vi.fn(async () => {});
    const config = {};
    const next = await maybeSeedControlUiLocalAuthAtStartup({
      config,
      writeConfig,
      env: {},
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(next).toBe(config);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("seeds localAuth enabled and session secret when requested by env", async () => {
    const writeConfig = vi.fn(async () => {});
    const next = await maybeSeedControlUiLocalAuthAtStartup({
      config: {},
      writeConfig,
      env: {
        OPENCLAW_LOCALAUTH_ENABLE: "1",
        OPENCLAW_LOCALAUTH_SESSION_SECRET: "seed-secret",
      },
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(next.gateway?.controlUi?.localAuth?.enabled).toBe(true);
    expect(next.gateway?.controlUi?.localAuth?.sessionSecret).toBe("seed-secret");
    expect(writeConfig).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite existing enabled localAuth session secret", async () => {
    const writeConfig = vi.fn(async () => {});
    const config = {
      gateway: {
        controlUi: {
          localAuth: {
            enabled: true,
            sessionSecret: "existing-secret",
          },
        },
      },
    };
    const next = await maybeSeedControlUiLocalAuthAtStartup({
      config,
      writeConfig,
      env: { OPENCLAW_LOCALAUTH_ENABLE: "1" },
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(next).toBe(config);
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
