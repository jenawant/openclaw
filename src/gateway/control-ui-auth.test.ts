import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  handleControlUiAuthHttpRequest,
  resolveControlUiViewerFromRequest,
} from "./control-ui-auth.js";
import { makeMockHttpResponse } from "./test-http-response.js";

function buildReq(params: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  const chunks = params.body ? [Buffer.from(params.body)] : [];
  const listeners: Record<string, Array<(value?: unknown) => void>> = {};
  const req = {
    url: params.url,
    method: params.method ?? "GET",
    headers: params.headers ?? {},
    socket: { encrypted: false },
    on(event: "data" | "end" | "error", listener: (value?: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(listener);
      if (event === "data") {
        for (const chunk of chunks) {
          listener(chunk);
        }
      }
      if (event === "end") {
        listener();
      }
      return req;
    },
  } as unknown as IncomingMessage;
  return req;
}

function localAuthConfig(): OpenClawConfig {
  return {
    gateway: {
      controlUi: {
        localAuth: {
          enabled: true,
          sessionSecret: "test-secret",
          sessionTtlHours: 24,
          users: [
            {
              username: "admin",
              passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
              role: "admin",
              agentId: "main",
              allowedChannels: [{ channel: "telegram", accountId: "work" }],
            },
          ],
        },
      },
    },
  };
}

function localAuthConfigWithoutUsers(): OpenClawConfig {
  return {
    gateway: {
      controlUi: {
        localAuth: {
          enabled: true,
          sessionSecret: "test-secret",
          sessionTtlHours: 24,
          seedAdminOnEmpty: true,
        },
      },
    },
  };
}

async function withEnv<T>(
  entries: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (typeof value === "string") {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

describe("control ui local auth http routes", () => {
  it("returns 404 when local auth is disabled", async () => {
    const { res, end } = makeMockHttpResponse();
    const handled = await handleControlUiAuthHttpRequest({
      req: buildReq({ url: "/__openclaw__/auth/me" }),
      res,
      cfg: { gateway: { controlUi: { localAuth: { enabled: false } } } },
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(String(end.mock.calls[0]?.[0] ?? "")).toContain("local auth not enabled");
  });

  it("logs in and sets cookie", async () => {
    const { res, setHeader, end } = makeMockHttpResponse();
    const handled = await handleControlUiAuthHttpRequest({
      req: buildReq({
        url: "/__openclaw__/auth/login",
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "pw-1" }),
      }),
      res,
      cfg: localAuthConfig(),
      deps: {
        verifyPassword: async (password, hash) =>
          password === "pw-1" && hash.includes("$argon2id$"),
      },
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
      ok: boolean;
      viewer: { username: string; role: string; agentId: string; mainSessionKey: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.viewer.username).toBe("admin");
    expect(payload.viewer.mainSessionKey).toBe("main");
    const setCookie = setHeader.mock.calls.find((call) => call[0] === "Set-Cookie")?.[1];
    expect(String(setCookie ?? "")).toContain("openclaw-ui-auth=");
  });

  it("returns viewer for valid cookie", async () => {
    const cfg = localAuthConfig();
    const loginRes = makeMockHttpResponse();
    await handleControlUiAuthHttpRequest({
      req: buildReq({
        url: "/__openclaw__/auth/login",
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "pw-1" }),
      }),
      res: loginRes.res,
      cfg,
      deps: {
        verifyPassword: async () => true,
      },
    });
    const cookieHeaderRaw = loginRes.setHeader.mock.calls.find(
      (call) => call[0] === "Set-Cookie",
    )?.[1];
    const cookie = String(cookieHeaderRaw).split(";")[0];

    const { res, end } = makeMockHttpResponse();
    const handled = await handleControlUiAuthHttpRequest({
      req: buildReq({
        url: "/__openclaw__/auth/me",
        headers: { cookie },
      }),
      res,
      cfg,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
      ok: boolean;
      viewer: { username: string; role: string; agentId: string; mainSessionKey: string };
    };
    expect(payload.viewer.role).toBe("admin");
    expect(payload.viewer.mainSessionKey).toBe("main");
  });

  it("resolves viewer from cookie helper", async () => {
    const cfg = localAuthConfig();
    const loginRes = makeMockHttpResponse();
    await handleControlUiAuthHttpRequest({
      req: buildReq({
        url: "/__openclaw__/auth/login",
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "pw-1" }),
      }),
      res: loginRes.res,
      cfg,
      deps: { verifyPassword: async () => true },
    });
    const cookieHeaderRaw = loginRes.setHeader.mock.calls.find(
      (call) => call[0] === "Set-Cookie",
    )?.[1];
    const cookie = String(cookieHeaderRaw).split(";")[0];
    const viewer = resolveControlUiViewerFromRequest({
      req: buildReq({
        url: "/chat",
        headers: { cookie },
      }),
      cfg,
    });
    expect(viewer?.username).toBe("admin");
    expect(viewer?.allowedChannels).toEqual([{ channel: "telegram", accountId: "work" }]);
  });

  it("auto-seeds admin on empty auth DB from env password", async () => {
    const dbPath = path.join(os.tmpdir(), `openclaw-auth-seed-${Date.now()}-${Math.random()}.db`);
    await withEnv(
      {
        OPENCLAW_CONTROL_UI_AUTH_DB_PATH: dbPath,
        OPENCLAW_LOCALAUTH_ADMIN_USERNAME: "seed-admin",
        OPENCLAW_LOCALAUTH_ADMIN_PASSWORD: "pw-seed",
        OPENCLAW_LOCALAUTH_ADMIN_PASSWORD_HASH: undefined,
        OPENCLAW_LOCALAUTH_ADMIN_AGENT_ID: "seed-agent",
      },
      async () => {
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiAuthHttpRequest({
          req: buildReq({
            url: "/__openclaw__/auth/login",
            method: "POST",
            body: JSON.stringify({ username: "seed-admin", password: "pw-seed" }),
          }),
          res,
          cfg: localAuthConfigWithoutUsers(),
          deps: {
            hashPassword: async (password) => `hashed:${password}`,
            verifyPassword: async (password, hash) => hash === `hashed:${password}`,
          },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        const payload = JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
          ok: boolean;
          viewer: {
            username: string;
            role: string;
            agentId: string;
            mainSessionKey: string;
            allowedChannels: Array<{ channel: string; accountId?: string }>;
          };
        };
        expect(payload.ok).toBe(true);
        expect(payload.viewer).toEqual({
          username: "seed-admin",
          role: "admin",
          agentId: "seed-agent",
          mainSessionKey: "main",
          allowedChannels: [],
        });
      },
    );
  });

  it("returns 503 when auth DB is empty and no seed credentials are provided", async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `openclaw-auth-seed-missing-${Date.now()}-${Math.random()}.db`,
    );
    await withEnv(
      {
        OPENCLAW_CONTROL_UI_AUTH_DB_PATH: dbPath,
        OPENCLAW_LOCALAUTH_ADMIN_USERNAME: undefined,
        OPENCLAW_LOCALAUTH_ADMIN_PASSWORD: undefined,
        OPENCLAW_LOCALAUTH_ADMIN_PASSWORD_HASH: undefined,
        OPENCLAW_LOCALAUTH_ADMIN_AGENT_ID: undefined,
      },
      async () => {
        const { res, end } = makeMockHttpResponse();
        const handled = await handleControlUiAuthHttpRequest({
          req: buildReq({
            url: "/__openclaw__/auth/login",
            method: "POST",
            body: JSON.stringify({ username: "admin", password: "pw-1" }),
          }),
          res,
          cfg: localAuthConfigWithoutUsers(),
          deps: {
            verifyPassword: async () => false,
          },
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(503);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toContain("auth DB is empty");
      },
    );
  });
});
