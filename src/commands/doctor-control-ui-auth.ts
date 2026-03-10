import type { OpenClawConfig } from "../config/config.js";
import {
  listControlUiAuthDbUsers,
  resolveControlUiAuthDbPathForDisplay,
} from "../gateway/control-ui-auth-db.js";

export function buildControlUiLocalAuthDoctorNote(
  cfg: OpenClawConfig,
): { title: string; body: string } | null {
  const localAuth = cfg.gateway?.controlUi?.localAuth;
  if (localAuth?.enabled !== true) {
    return null;
  }
  const seedMode = localAuth.seedAdminOnEmpty !== false ? "enabled" : "disabled";
  try {
    const users = listControlUiAuthDbUsers(cfg);
    const adminCount = users.filter((entry) => entry.role === "admin" && !entry.disabled).length;
    const body = [
      `- localAuth: enabled`,
      `- auth DB: ${resolveControlUiAuthDbPathForDisplay()}`,
      `- users: ${users.length}`,
      `- active admins: ${adminCount}`,
      `- seedAdminOnEmpty: ${seedMode}`,
    ].join("\n");
    return {
      title: "Control UI users",
      body,
    };
  } catch (error) {
    return {
      title: "Control UI users",
      body: [
        "- localAuth: enabled",
        `- auth DB: ${resolveControlUiAuthDbPathForDisplay()}`,
        `- auth DB status: unavailable (${String(error)})`,
        `- seedAdminOnEmpty: ${seedMode}`,
      ].join("\n"),
    };
  }
}
