import type { Risk } from "../types.js";
import type { Theme } from "./theme.js";

/**
 * Lets the React UI register handlers that non-React code (the
 * PermissionManager, the slash-command switch) can call into. The UI is
 * created after these callers, so they reach it through this singleton.
 */
export interface UiBridge {
  askPermission?: (description: string, risk: Risk, preview?: string) => Promise<"yes" | "no" | "always" | "always_deny">;
  /** Swap the active palette (used by `/theme`); the UI re-renders in place. */
  setTheme?: (theme: Theme) => void;
  /** Current palette, so the CLI can describe it without touching React. */
  getTheme?: () => Theme | undefined;
}

export const bridge: UiBridge = {};
