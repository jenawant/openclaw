import { randomBytes } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";

const LOCALAUTH_ENABLE_ENV = "OPENCLAW_LOCALAUTH_ENABLE";
const LOCALAUTH_SESSION_SECRET_ENV = "OPENCLAW_LOCALAUTH_SESSION_SECRET";

function envWantsLocalAuth(env: NodeJS.ProcessEnv): boolean {
  const raw = env[LOCALAUTH_ENABLE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveBootstrapSessionSecret(env: NodeJS.ProcessEnv): string {
  const seeded = env[LOCALAUTH_SESSION_SECRET_ENV]?.trim();
  if (seeded) {
    return seeded;
  }
  return randomBytes(32).toString("base64url");
}

export async function maybeSeedControlUiLocalAuthAtStartup(params: {
  config: OpenClawConfig;
  writeConfig: (config: OpenClawConfig) => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  env?: NodeJS.ProcessEnv;
}): Promise<OpenClawConfig> {
  const env = params.env ?? process.env;
  if (!envWantsLocalAuth(env)) {
    return params.config;
  }
  const localAuth = params.config.gateway?.controlUi?.localAuth;
  const hasEnabled = localAuth?.enabled === true;
  const hasSessionSecret = Boolean(localAuth?.sessionSecret);
  if (hasEnabled && hasSessionSecret) {
    return params.config;
  }

  const nextConfig: OpenClawConfig = {
    ...params.config,
    gateway: {
      ...params.config.gateway,
      controlUi: {
        ...params.config.gateway?.controlUi,
        localAuth: {
          ...localAuth,
          enabled: true,
          sessionSecret: localAuth?.sessionSecret ?? resolveBootstrapSessionSecret(env),
        },
      },
    },
  };
  try {
    await params.writeConfig(nextConfig);
    params.log.info(
      "gateway: seeded gateway.controlUi.localAuth.enabled=true and sessionSecret at startup (OPENCLAW_LOCALAUTH_ENABLE=1)",
    );
  } catch (error) {
    params.log.warn(
      `gateway: failed to persist localAuth bootstrap seed: ${String(error)}. Continuing with in-memory config.`,
    );
  }
  return nextConfig;
}
