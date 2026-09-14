import { parse as parseYaml } from "yaml";

export type ReviewerInitialContext = "fresh" | "inherit";
export type ReviewerContextMode = "retained" | "fresh";

export interface LedgerConfig {
  version: 1;
  reviewer: {
    model: string | null;
    initialContext: ReviewerInitialContext;
    contextMode: ReviewerContextMode;
    maxRounds: number;
  };
}

export const DEFAULT_CONFIG: LedgerConfig = {
  version: 1,
  reviewer: {
    model: null,
    initialContext: "fresh",
    contextMode: "retained",
    maxRounds: 3,
  },
};

export function parseLedgerConfig(source: string): LedgerConfig {
  const value = parseYaml(source) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ledger config must be a YAML mapping");
  }

  const root = value as Record<string, unknown>;
  if (root.version !== 1) throw new Error("ledger config version must be 1");
  if (root.reviewer !== undefined && (!root.reviewer || typeof root.reviewer !== "object" || Array.isArray(root.reviewer))) {
    throw new Error("reviewer must be a YAML mapping");
  }

  const reviewer = (root.reviewer ?? {}) as Record<string, unknown>;
  const model = reviewer.model ?? null;
  const initialContext = reviewer.initialContext ?? DEFAULT_CONFIG.reviewer.initialContext;
  const contextMode = reviewer.contextMode ?? DEFAULT_CONFIG.reviewer.contextMode;
  const maxRounds = reviewer.maxRounds ?? DEFAULT_CONFIG.reviewer.maxRounds;

  if (model !== null && (typeof model !== "string" || model.trim() === "")) {
    throw new Error("reviewer.model must be null or a non-empty Pi model reference");
  }
  if (initialContext !== "fresh" && initialContext !== "inherit") {
    throw new Error('reviewer.initialContext must be "fresh" or "inherit"');
  }
  if (contextMode !== "retained" && contextMode !== "fresh") {
    throw new Error('reviewer.contextMode must be "retained" or "fresh"');
  }
  if (!Number.isInteger(maxRounds) || (maxRounds as number) < 1) {
    throw new Error("reviewer.maxRounds must be a positive integer");
  }

  return {
    version: 1,
    reviewer: {
      model: typeof model === "string" ? model.trim() : null,
      initialContext,
      contextMode,
      maxRounds: maxRounds as number,
    },
  };
}
