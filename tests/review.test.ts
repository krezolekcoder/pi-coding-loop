import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewResult, reviewTransition, shouldCreateReviewer } from "../extensions/pi-coding-loop/review.ts";

const approved = parseReviewResult({ verdict: "APPROVED", summary: "All criteria pass.", issues: [] });
const changes = parseReviewResult({
  verdict: "CHANGES_REQUESTED",
  summary: "Retry coverage is incomplete.",
  issues: [{ severity: "major", description: "HTTP 503 is not retried", file: "src/client.ts", line: 42 }],
});

test("parses structured review results", () => {
  assert.equal(approved.verdict, "APPROVED");
  assert.equal(changes.issues[0].line, 42);
  assert.throws(() => parseReviewResult({ verdict: "YES", summary: "x", issues: [] }), /verdict/);
  assert.throws(() => parseReviewResult({ verdict: "CHANGES_REQUESTED", summary: "x", issues: [] }), /actionable issue/);
});

test("counts the last allowed review before blocking", () => {
  assert.equal(reviewTransition(changes, 2, 3), "continue");
  assert.equal(reviewTransition(changes, 3, 3), "block");
  assert.equal(reviewTransition(approved, 3, 3), "complete");
});

test("retained mode reuses only the current task reviewer", () => {
  assert.equal(shouldCreateReviewer("retained", "TASK-001", "TASK-001"), false);
  assert.equal(shouldCreateReviewer("retained", "TASK-001", "TASK-002"), true);
  assert.equal(shouldCreateReviewer("fresh", "TASK-001", "TASK-001"), true);
});
