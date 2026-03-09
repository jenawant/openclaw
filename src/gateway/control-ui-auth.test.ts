import type { IncomingMessage } from "node:http";
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
});
