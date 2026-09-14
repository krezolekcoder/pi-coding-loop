import assert from "node:assert/strict";
import test from "node:test";
import { parseLedger, selectActiveTask, updateTaskStatus } from "../extensions/pi-coding-loop/ledger.ts";

const source = `# Ledger

## TASK-001 -- First
Status: completed
### Goal
Do one thing.
### Acceptance Criteria
- it works

## TASK-002 -- Second
Status: in_progress
### Goal
Do another thing.
### Scope
Only the requested seam.
### Acceptance Criteria
- behavior is covered
### Notes
Keep it small.

## TASK-003 -- Third
Status: pending
### Goal
Finish.
### Acceptance Criteria
- done
`;

test("parses task contracts and selects an in-progress task first", () => {
  const ledger = parseLedger(source);
  assert.equal(ledger.tasks.length, 3);
  assert.equal(ledger.tasks[1].scope, "Only the requested seam.");
  assert.equal(ledger.tasks[1].notes, "Keep it small.");
  assert.equal(selectActiveTask(ledger)?.id, "TASK-002");
});

test("selects the first pending task in document order", () => {
  const pending = source.replace("Status: in_progress", "Status: pending");
  assert.equal(selectActiveTask(parseLedger(pending))?.id, "TASK-002");
});

test("updates only the requested status and records a one-line blocked reason", () => {
  const completed = updateTaskStatus(source, "TASK-002", "completed");
  assert.equal(parseLedger(completed).tasks[1].status, "completed");
  assert.equal(parseLedger(completed).tasks[2].status, "pending");

  const blocked = updateTaskStatus(source, "TASK-002", "blocked", "Need API\ncredentials");
  assert.match(blocked, /Status: blocked\nBlocked Reason: Need API credentials/);
  assert.equal((blocked.match(/Blocked Reason:/g) ?? []).length, 1);

  const crlf = updateTaskStatus(source.replaceAll("\n", "\r\n"), "TASK-002", "blocked", "External input");
  assert.match(crlf, /Status: blocked\r\nBlocked Reason: External input\r\n/);
  assert.equal(parseLedger(crlf).tasks[1].status, "blocked");
});

test("rejects duplicate IDs, missing goals, and multiple active tasks", () => {
  assert.throws(() => parseLedger(source.replace("TASK-003", "TASK-002")), /duplicate task ID/);
  assert.throws(() => parseLedger(source.replace("### Goal\nDo one thing.", "### Goal\n")), /Goal/);
  assert.throws(() => parseLedger(source.replace("Status: pending", "Status: in_progress")), /more than one/);
});
