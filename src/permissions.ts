import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Risk } from "./types.js";

export type Mode = "default" | "auto" | "yolo"; // auto = accept edits, still asks for high risk; yolo = accept everything

interface Rule {
  match: string; // substring of the permission description
  decision: "allow" | "deny";
}

const CONFIG_DIR = path.join(os.homedir(), ".node-agent");
const RULES_FILE = path.join(CONFIG_DIR, "permissions.json");

export class PermissionManager {
  mode: Mode = "default";
  private rules: Rule[] = [];
  /** Provided by the CLI: prompt the user. */
  askUser: (description: string, risk: Risk) => Promise<"yes" | "no" | "always" | "always_deny">;

  constructor(askUser: PermissionManager["askUser"]) {
    this.askUser = askUser;
  }

  async load() {
    try {
      const raw = await fs.readFile(RULES_FILE, "utf8");
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
      this.rules = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.rules = [];
    }
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
    await this.save();
    return n;
  }

  async check(description: string, risk: Risk, readOnly: boolean): Promise<boolean> {
    if (readOnly) return true;

    // Persisted rules win over any mode except yolo, so a "deny always" is
    // never silently bypassed by switching to auto mode.
    if (this.mode !== "yolo") {
      for (const r of this.rules) {
        if (description.includes(r.match)) return r.decision === "allow";
      }
    }
    if (this.mode === "yolo") return true;

    // In auto mode, non-high-risk operations are accepted silently.
    if (this.mode === "auto" && risk !== "high") return true;

    const answer = await this.askUser(description, risk);
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
