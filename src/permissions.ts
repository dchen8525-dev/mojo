import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionRequest, Risk } from "./types.js";
import { normalizeRuleValue, parseStructuredRule, patternKind, patternMatches } from "./permissionRules.js";
import { Mutex } from "./sync.js";

export type Mode = "default" | "auto" | "yolo"; // auto = accept edits, still asks for high risk; yolo = accept everything

export interface PermissionRule {
  match: string; // `tool(pattern)` when structured; otherwise a legacy description substring (`*` is a wildcard)
  decision: "allow" | "deny";
}

export type RuleScope = "global" | "project";

/** Shown in the prompt so the user knows what an "always" answer will save. */
export interface PermissionAskMeta {
  tool: string;
  rule: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".node-agent");
const RULES_FILE = path.join(CONFIG_DIR, "permissions.json");
/** Sanity cap for manually added rules; auto-saved compound commands can be long. */
const MAX_RULE_LENGTH = 4000;

/** Read a permissions file (array of { match, decision }) or [] on any problem. */
export async function loadRulesFrom(file: string): Promise<PermissionRule[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r && typeof r.match === "string" && (r.decision === "allow" || r.decision === "deny"));
  } catch {
    return [];
  }
}

async function saveRules(file: string, rules: PermissionRule[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(rules, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
}

/**
 * Legacy rule matching by description. A rule containing `*` is treated as a
 * glob (e.g. "read_file:*", "bash: npm run *"); otherwise it's a plain
 * substring match (e.g. "## Summary React Native v0.2").
 *
 * Structured rules (`bash(npm test:*)`) are matched by `PermissionManager`
 * against tool values instead; this helper stays for legacy rules.
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
  private rules: PermissionRule[] = [];
  private projectRules: PermissionRule[] = [];
  /** Grants answered with "session": in-memory only, they die with the process. */
  private sessionRules: PermissionRule[] = [];
  /**
   * Serializes interactive prompts. Parallel subagents can call check() at the
   * same instant; without this, the TUI's single prompt slot (and print mode's
   * readline) would be clobbered by the second request, leaving the first
   * worker's Promise unresolved and the whole turn deadlocked.
   */
  private readonly promptLock = new Mutex();
  /**
   * Provided by the CLI: prompt the user. `preview` is optional multi-line detail (e.g. a diff).
   * - "yes": allow once
   * - "session": allow until the session ends (in-memory, never persisted)
   * - "project": persist an allow rule to the project's permissions.json
   * - "always": persist an allow rule to the global permissions.json
   * - "always_deny": persist a deny rule globally
   * - "no": deny once
   */
  askUser: (
    description: string,
    risk: Risk,
    preview?: string,
    meta?: PermissionAskMeta,
  ) => Promise<"yes" | "no" | "session" | "project" | "always" | "always_deny">;

  constructor(askUser: PermissionManager["askUser"]) {
    this.askUser = askUser;
  }

  async load() {
    this.rules = await loadRulesFrom(RULES_FILE);
  }

  private projectFile: string | null = null;

  /** Load a project-scoped net-new file (e.g. `<cwd>/.node-agent/permissions.json`). Takes precedence over global rules. */
  async loadProject(cwd: string) {
    this.projectFile = path.join(cwd, ".node-agent", "permissions.json");
    this.projectRules = await loadRulesFrom(this.projectFile);
  }

  private async save() {
    await saveRules(RULES_FILE, this.rules);
  }

  getRules(): readonly PermissionRule[] {
    return this.rules;
  }

  getProjectRules(): readonly PermissionRule[] {
    return this.projectRules;
  }

  /** Grants made with "session" this run — visible so UIs can report them. */
  getSessionRules(): readonly PermissionRule[] {
    return this.sessionRules;
  }

  /** Append a rule and persist it to the chosen layer; it applies immediately. */
  async addRule(scope: RuleScope, match: string, decision: PermissionRule["decision"]): Promise<PermissionRule> {
    const clean = match.trim();
    if (!clean) throw new Error("match is required");
    if (clean.length > MAX_RULE_LENGTH) throw new Error(`match is too long (max ${MAX_RULE_LENGTH} characters)`);
    if (decision !== "allow" && decision !== "deny") throw new Error("decision must be allow or deny");
    const rule: PermissionRule = { match: clean, decision };
    if (scope === "project") {
      if (!this.projectFile) throw new Error("no project loaded");
      this.projectRules.push(rule);
      await saveRules(this.projectFile, this.projectRules);
    } else {
      this.rules.push(rule);
      await this.save();
    }
    return rule;
  }

  /** Remove the rule at `index` from a layer; null when the index is out of range. */
  async removeRule(scope: RuleScope, index: number): Promise<PermissionRule | null> {
    if (!Number.isInteger(index) || index < 0) return null;
    const list = scope === "project" ? this.projectRules : this.rules;
    if (index >= list.length) return null;
    const [removed] = list.splice(index, 1);
    if (scope === "project") {
      if (!this.projectFile) throw new Error("no project loaded");
      await saveRules(this.projectFile, this.projectRules);
    } else {
      await this.save();
    }
    return removed;
  }

  /**
   * Drop the persisted global rules and the in-memory project rules. Project
   * rules live in `<cwd>/.node-agent/permissions.json` and are *not* deleted
   * from disk, so they return on the next `loadProject` — the counts are split
   * so callers can report that honestly.
   */
  async clearRules(): Promise<{ global: number; project: number }> {
    const global = this.rules.length;
    const project = this.projectRules.length;
    this.rules = [];
    this.projectRules = [];
    this.sessionRules = [];
    await this.save();
    return { global, project };
  }

  private layers(): PermissionRule[][] {
    return [this.projectRules, this.rules, this.sessionRules];
  }

  /** First matching rule (project before global before session) decides the outcome, or null. */
  private ruleDecision(description: string, request?: PermissionRequest): boolean | null {
    if (request && request.tool.toLowerCase() === "bash") return this.bashDecision(description, request);
    return this.valueDecision(description, request);
  }

  /**
   * File tools and anything else without a shell: tool values or legacy
   * descriptions. `legacy` is false while checking compound bash segments —
   * a description rule that mentions one sub-command must not vouch for the
   * others.
   */
  private valueDecision(description: string, request?: PermissionRequest, legacy = true): boolean | null {
    for (const list of this.layers()) {
      for (const r of list) {
        const parsed = parseStructuredRule(r.match);
        if (parsed) {
          // Without a structured request there is nothing to match safely
          // against, so a tool rule never falls back to the description.
          if (!request || parsed.tool !== request.tool) continue;
          const kind = patternKind(parsed.pattern, parsed.tool);
          const pattern = normalizeRuleValue(parsed.tool, parsed.pattern);
          if (request.values.some((v) => patternMatches(pattern, normalizeRuleValue(parsed.tool, v), kind))) {
            return r.decision === "allow";
          }
          continue;
        }
        if (legacy && ruleMatches(r.match, description)) return r.decision === "allow";
      }
    }
    return null;
  }

  /**
   * Bash rules are evaluated against the parsed sub-commands, never against
   * the description alone:
   * - an exact whole-command rule may decide any request;
   * - deny rules always decide, in every shape;
   * - a compound command is allowed only when *every* sub-command is covered
   *   by a structured allow rule (legacy allows cannot cover a compound);
   * - an opaque command (substitutions, subshells…) is never auto-allowed by
   *   prefix/glob — it prompts unless an exact rule covers it.
   */
  private bashDecision(description: string, request: PermissionRequest): boolean | null {
    const raw = (request.raw ?? request.values.join(" ; ")).trim();
    // Exact whole-command rules can cover requests the splitter cannot reason
    // about (opaque), or a whole compound the user approved as one unit.
    for (const list of this.layers()) {
      for (const r of list) {
        const parsed = parseStructuredRule(r.match);
        if (!parsed || parsed.tool.toLowerCase() !== "bash") continue;
        if (patternKind(parsed.pattern, "bash") !== "exact") continue;
        if (patternMatches(parsed.pattern, raw, "exact")) return r.decision === "allow";
      }
    }
    // Denies are always safe to apply, including legacy description denies.
    for (const list of this.layers()) {
      for (const r of list) {
        if (r.decision === "deny" && ruleMatches(r.match, description)) return false;
      }
    }
    if (request.opaque) return null;
    const segments = request.values;
    if (segments.length === 0) return null;
    if (segments.length === 1) {
      // A simple command keeps the historical first-match semantics, so
      // existing description rules (e.g. "Run command: npm test") still work.
      return this.valueDecision(description, {
        tool: "bash",
        values: segments,
        raw: segments[0],
      });
    }
    let allCovered = true;
    for (const segment of segments) {
      const decided = this.valueDecision(description, { tool: "bash", values: [segment], raw: segment }, false);
      if (decided === false) return false;
      if (decided === null) allCovered = false;
    }
    return allCovered ? true : null;
  }

  async check(
    description: string,
    risk: Risk,
    readOnly: boolean,
    preview?: string,
    request?: PermissionRequest,
  ): Promise<boolean> {
    if (readOnly) return true;

    // Project-scoped rules are decided first (so a project can deny even a
    // global "allow"), then persisted global rules. "always deny" survives
    // auto mode; only yolo bypasses everything.
    if (this.mode !== "yolo") {
      const decided = this.ruleDecision(description, request);
      if (decided !== null) return decided;
    }
    if (this.mode === "yolo") return true;

    // In auto mode, non-high-risk operations are accepted silently.
    if (this.mode === "auto" && risk !== "high") return true;

    return this.promptLock.runExclusive(() => this.askAndPersist(description, risk, preview, request));
  }

  /** Rule text persisted for an answer other than yes/no. */
  private persistKey(description: string, request?: PermissionRequest): string {
    if (!request) return description.slice(0, 60);
    const remembered = request.remember?.trim();
    if (remembered) return remembered;
    const value = (request.raw ?? request.values[0] ?? description).trim();
    return `${request.tool}(${value})`;
  }

  /**
   * Ask the user with the prompt lock held. Re-checks rules first: a request
   * that queued behind another may now be covered by an "always" answer that
   * landed while it waited, so it resolves without a second prompt.
   */
  private async askAndPersist(
    description: string,
    risk: Risk,
    preview?: string,
    request?: PermissionRequest,
  ): Promise<boolean> {
    if (this.mode !== "yolo") {
      const decided = this.ruleDecision(description, request);
      if (decided !== null) return decided;
    }
    const key = this.persistKey(description, request);
    const meta: PermissionAskMeta | undefined = request ? { tool: request.tool, rule: key } : undefined;
    const answer = await this.askUser(description, risk, preview, meta);
    if (answer !== "yes" && answer !== "no") {
      // Persist the exact structured rule the user was shown; never a broad
      // prefix derived from a description (that is how compound commands
      // used to slip through an unrelated "always" grant).
      const rule: PermissionRule = { match: key, decision: answer === "always_deny" ? "deny" : "allow" };
      if (answer === "session") {
        this.sessionRules.push(rule);
        return rule.decision === "allow";
      }
      if (answer === "project" && this.projectFile) {
        this.projectRules.push(rule);
        await saveRules(this.projectFile, this.projectRules);
        return rule.decision === "allow";
      }
      // "always", or "project" with no project file loaded: persist globally.
      this.rules.push(rule);
      await this.save();
      return rule.decision === "allow";
    }
    return answer === "yes";
  }
}
