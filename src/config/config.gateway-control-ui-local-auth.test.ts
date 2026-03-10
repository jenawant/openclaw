import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";
import { buildConfigSchema } from "./schema.js";

describe("gateway.controlUi.localAuth", () => {
  it("accepts valid local auth config", () => {
    const result = validateConfigObject({
      gateway: {
        controlUi: {
          localAuth: {
            enabled: true,
            sessionSecret: "secret-1",
            sessionTtlHours: 24,
            seedAdminOnEmpty: true,
            seedAdminUsername: "admin",
            users: [
              {
                username: "admin",
                passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
                role: "admin",
                agentId: "main",
              },
            ],
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate usernames (case-insensitive)", () => {
    const result = validateConfigObject({
      gateway: {
        controlUi: {
          localAuth: {
            users: [
              {
                username: "Admin",
                passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
                role: "admin",
                agentId: "main",
              },
              {
                username: "admin",
                passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
                role: "user",
                agentId: "ops",
              },
            ],
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) =>
            issue.path === "gateway.controlUi.localAuth.users.1.username" &&
            issue.message.includes("duplicate username"),
        ),
      ).toBe(true);
    }
  });

  it("marks session secret and password hash as sensitive schema hints", () => {
    const schema = buildConfigSchema();
    expect(schema.uiHints["gateway.controlUi.localAuth.sessionSecret"]?.sensitive).toBe(true);
    expect(schema.uiHints["gateway.controlUi.localAuth.users[].passwordHash"]?.sensitive).toBe(
      true,
    );
  });

  it("accepts auto-seed settings without static users", () => {
    const result = validateConfigObject({
      gateway: {
        controlUi: {
          localAuth: {
            enabled: true,
            sessionSecret: "secret-1",
            seedAdminOnEmpty: true,
            seedAdminUsername: "bootstrap-admin",
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });
});
