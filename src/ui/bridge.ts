import type { Risk } from "../types.js";

/**
 * Lets the React UI register a permission prompt handler that the
 * PermissionManager (created before the UI exists) can call into.
 */
export interface UiBridge {
  askPermission?: (description: string, risk: Risk) => Promise<"yes" | "no" | "always" | "always_deny">;
}

export const bridge: UiBridge = {};
