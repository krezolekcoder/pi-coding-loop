export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface LedgerTask {
  id: string;
  title: string;
  status: TaskStatus;
  goal: string;
  acceptanceCriteria: string;
  scope?: string;
  notes?: string;
  dependsOn?: string;
  start: number;
  end: number;
  statusValueStart: number;
  statusValueEnd: number;
  statusLineEnd: number;
}

export interface ParsedLedger {
  source: string;
  tasks: LedgerTask[];
}

const TASK_HEADING = /^##[ \t]+(TASK-[A-Za-z0-9_-]+)[ \t]+--[ \t]+(.+?)[ \t]*(?=\r?$)/gm;
const ALLOWED_STATUSES = new Set<TaskStatus>(["pending", "in_progress", "completed", "blocked"]);

function sectionMap(block: string): Map<string, string> {
  const headings = [...block.matchAll(/^###[ \t]+(.+?)[ \t]*(?=\r?$)/gm)];
  const sections = new Map<string, string>();
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const name = heading[1].trim().toLowerCase();
    const contentStart = heading.index! + heading[0].length;
    const contentEnd = headings[index + 1]?.index ?? block.length;
    sections.set(name, block.slice(contentStart, contentEnd).trim().replace(/\r?\n---[ \t]*$/, "").trim());
  }
  return sections;
}

export function parseLedger(source: string): ParsedLedger {
  const headings = [...source.matchAll(TASK_HEADING)];
  if (headings.length === 0) throw new Error("ledger contains no TASK headings");

  const tasks: LedgerTask[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const id = heading[1];
    if (ids.has(id)) throw new Error(`duplicate task ID: ${id}`);
    ids.add(id);

    const start = heading.index!;
    const end = headings[index + 1]?.index ?? source.length;
    const block = source.slice(start, end);
    const statusMatches = [...block.matchAll(/^Status:[ \t]*(\S+)[ \t]*(?=\r?$)/gm)];
    if (statusMatches.length === 0) throw new Error(`${id} is missing Status`);
    if (statusMatches.length > 1) throw new Error(`${id} has more than one Status line`);
    const statusMatch = statusMatches[0];
    const status = statusMatch[1] as TaskStatus;
    if (!ALLOWED_STATUSES.has(status)) throw new Error(`${id} has unsupported status: ${statusMatch[1]}`);

    const sections = sectionMap(block);
    const goal = sections.get("goal") ?? "";
    const acceptanceCriteria = sections.get("acceptance criteria") ?? "";
    if (!goal) throw new Error(`${id} is missing a non-empty Goal section`);
    if (!acceptanceCriteria || !/^\s*[-*]\s+\S/m.test(acceptanceCriteria)) {
      throw new Error(`${id} must have at least one Acceptance Criteria list item`);
    }

    const statusValueStart = start + statusMatch.index + statusMatch[0].indexOf(statusMatch[1]);
    tasks.push({
      id,
      title: heading[2].trim(),
      status,
      goal,
      acceptanceCriteria,
      scope: sections.get("scope") || undefined,
      notes: sections.get("notes") || undefined,
      dependsOn: sections.get("depends on") || undefined,
      start,
      end,
      statusValueStart,
      statusValueEnd: statusValueStart + statusMatch[1].length,
      statusLineEnd: start + statusMatch.index + statusMatch[0].length,
    });
  }

  if (tasks.filter((task) => task.status === "in_progress").length > 1) {
    throw new Error("ledger contains more than one in_progress task");
  }
  return { source, tasks };
}

export function selectActiveTask(ledger: ParsedLedger): LedgerTask | undefined {
  return ledger.tasks.find((task) => task.status === "in_progress")
    ?? ledger.tasks.find((task) => task.status === "pending");
}

export function updateTaskStatus(source: string, taskId: string, status: TaskStatus, blockedReason?: string): string {
  const task = parseLedger(source).tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);

  let updated = source.slice(0, task.statusValueStart) + status + source.slice(task.statusValueEnd);
  if (status !== "blocked") return updated;

  const reason = (blockedReason ?? "No reason provided").replace(/\s+/g, " ").trim().slice(0, 500);
  const reparsed = parseLedger(updated).tasks.find((candidate) => candidate.id === taskId)!;
  const block = updated.slice(reparsed.start, reparsed.end);
  const existing = /^Blocked Reason:[ \t]*[^\r\n]*(?=\r?$)/m.exec(block);
  if (existing) {
    const from = reparsed.start + existing.index;
    return updated.slice(0, from) + `Blocked Reason: ${reason}` + updated.slice(from + existing[0].length);
  }

  const newline = updated.includes("\r\n") ? "\r\n" : "\n";
  return updated.slice(0, reparsed.statusLineEnd)
    + `${newline}Blocked Reason: ${reason}`
    + updated.slice(reparsed.statusLineEnd);
}

export function formatTask(task: LedgerTask): string {
  const fields = [
    `Task: ${task.id} -- ${task.title}`,
    `Goal:\n${task.goal}`,
    task.scope ? `Scope:\n${task.scope}` : undefined,
    `Acceptance Criteria:\n${task.acceptanceCriteria}`,
    task.notes ? `Relevant Notes:\n${task.notes}` : undefined,
    task.dependsOn ? `Depends On:\n${task.dependsOn}` : undefined,
  ];
  return fields.filter(Boolean).join("\n\n");
}
