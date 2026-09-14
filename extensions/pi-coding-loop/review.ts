export type ReviewVerdict = "APPROVED" | "CHANGES_REQUESTED" | "BLOCKED";
export type IssueSeverity = "critical" | "major" | "minor";

export interface ReviewIssue {
  severity: IssueSeverity;
  description: string;
  file?: string;
  line?: number;
  suggestedFix?: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  issues: ReviewIssue[];
}

const VERDICTS = new Set<ReviewVerdict>(["APPROVED", "CHANGES_REQUESTED", "BLOCKED"]);
const SEVERITIES = new Set<IssueSeverity>(["critical", "major", "minor"]);

export function parseReviewResult(value: unknown): ReviewResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review result must be an object");
  const input = value as Record<string, unknown>;
  if (!VERDICTS.has(input.verdict as ReviewVerdict)) throw new Error("review result has an invalid verdict");
  if (typeof input.summary !== "string" || !input.summary.trim()) throw new Error("review result summary is required");
  if (!Array.isArray(input.issues)) throw new Error("review result issues must be an array");

  const issues = input.issues.map((value, index): ReviewIssue => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`review issue ${index + 1} must be an object`);
    const issue = value as Record<string, unknown>;
    if (!SEVERITIES.has(issue.severity as IssueSeverity)) throw new Error(`review issue ${index + 1} has an invalid severity`);
    if (typeof issue.description !== "string" || !issue.description.trim()) throw new Error(`review issue ${index + 1} needs a description`);
    if (issue.file !== undefined && typeof issue.file !== "string") throw new Error(`review issue ${index + 1} file must be a string`);
    if (issue.line !== undefined && (!Number.isInteger(issue.line) || (issue.line as number) < 1)) throw new Error(`review issue ${index + 1} line must be a positive integer`);
    if (issue.suggestedFix !== undefined && typeof issue.suggestedFix !== "string") throw new Error(`review issue ${index + 1} suggestedFix must be a string`);
    return {
      severity: issue.severity as IssueSeverity,
      description: issue.description.trim(),
      file: issue.file as string | undefined,
      line: issue.line as number | undefined,
      suggestedFix: issue.suggestedFix as string | undefined,
    };
  });

  const verdict = input.verdict as ReviewVerdict;
  if (verdict === "CHANGES_REQUESTED" && issues.length === 0) {
    throw new Error("CHANGES_REQUESTED requires at least one actionable issue");
  }
  return { verdict, summary: input.summary.trim(), issues };
}

export type ReviewTransition = "complete" | "continue" | "block";

export function reviewTransition(result: ReviewResult, round: number, maxRounds: number): ReviewTransition {
  if (result.verdict === "APPROVED") return "complete";
  if (result.verdict === "BLOCKED") return "block";
  return round >= maxRounds ? "block" : "continue";
}

export function shouldCreateReviewer(contextMode: "retained" | "fresh", retainedTaskId: string | undefined, taskId: string): boolean {
  return contextMode === "fresh" || retainedTaskId !== taskId;
}

export function formatIssues(issues: ReviewIssue[]): string {
  if (issues.length === 0) return "None.";
  return issues.map((issue, index) => {
    const location = issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ""})` : "";
    const fix = issue.suggestedFix ? `\n   Suggested fix: ${issue.suggestedFix}` : "";
    return `${index + 1}. [${issue.severity}] ${issue.description}${location}${fix}`;
  }).join("\n");
}
