import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Risk } from "./types.js";

export type Mode = "default" | "auto" | "yolo"; // auto = accept edits, still asks for high risk; yolo = accept everything

interface Rule {
  match: string; // substring of the permission description; `*` is a wildcard
  decision: "allow" | "deny";
}

const CONFIG_DIR = path.join(os.homedir(), ".node-agent");
const RULES_FILE = path.join(CONFIG_DIR, "permissions.json");

/** Read a permissions file (array of { match, decision }) or [] on any problem. */
export async function loadRulesFrom(file: string): Promise<Rule[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r && typeof r.match === "string" && (r.decision === "allow" || r.decision === "deny"));
  } catch {
    return [];
  }
}

/**
 * Match a permission description against a rule. A rule containing `*` is
 * treated as a glob (e.g. "read_file:*", "bash: npm run *"); otherwise it's a
 * plain substring match (e.g. "## Summary React Native v0.2".
 */
export function ruleMatches(match: string, description: string): boolean {
  if (!match.includes("*")) return description.includes(match);
  // Wildcard is a substring glob (descriptions carry prefixes like "Run git …"),
  // so don't anchor it to the start of the string.
  try {
    return new RegExp(match.split("*").map(escapeRe).join(".*")).test(description);
  } catch {
    return false;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PermissionManager {
  mode: Mode = "default";
  private rules: Rule[] = [];
  private projectRules: Rule[] = [];
  /** Provided by the CLI: prompt the user. `preview` is optional multi-line detail (e.g. a diff). */
  askUser: (description: string, risk: Risk, preview?: string) => Promise<"yes" | "no" | "always" | "always_deny">;

  constructor(askUser: PermissionManager["askUser"]) {
    this.askUser = askUser;
  }

  async load() {
    this.rules = await loadRulesFrom(RULES_FILE);
  }

  /** Load a project-scoped net-new file (e.g. `<cwd>/.node-agent/permissions.json`). Takes precedence over global rules. */
  async loadProject(cwd: string) {
    this.projectRules = await loadRulesFrom(path.join(cwd, ".node-agent", "permissions.json"));
  }

  private async save() {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(RULES_FILE, JSON.stringify(this.rules, null, 2), "utf8");
  }

  getRules(): readonly Rule[] {
    return this.rules;
  }

  async clearRules(): Promise<number> {
    const n = this.rules.length;
    this.rules = [];
    this.projectRules = [];
    await this.save();
    return n;
  }

  async check(description: string, risk: Risk, readOnly: boolean, preview?: string): Promise<boolean> {
    if (readOnly) return true;

    // Project-scoped rules are decided first (so a project can deny even a
    // global "allow"), then persisted global rules. "always deny" survives
    // auto mode; only yolo bypasses everything.
    if (this.mode !== "yolo") {
      for (const r of this.projectRules) {
        if (ruleMatches(r.match, description)) return r.decision === "allow";
      }
      for (const r of this.rules) {
        if (ruleMatches(r.match, description)) return r.decision === "allow";
      }
    }
    if (this.mode === "yolo") return true;

    // In auto mode, non-high-risk operations are accepted silently.
    if (this.mode === "auto" && risk !== "high") return true;

    const answer = await this.askUser(description, risk, preview);
    if (answer === "always" || answer === "always_deny") {
      // Persist a rule keyed on the leading verb + target of the description.
      const key = description.slice(0, 60);
      this.rules.push({ match: key, decision: answer === "always" ? "allow" : "deny" });
      await this.save();
      return answer === "always";
    }
    return answer === "yes";
  }
}
