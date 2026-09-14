import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type LedgerConfig, parseLedgerConfig } from "./config.ts";
import { formatTask, parseLedger, selectActiveTask, type LedgerTask, updateTaskStatus } from "./ledger.ts";
import {
  formatIssues,
  parseReviewResult,
  type ReviewResult,
  reviewTransition,
  shouldCreateReviewer,
} from "./review.ts";

const REVIEWER_SYSTEM_PROMPT = `You are now acting strictly as the REVIEWER for an active implementation ledger task.
Do not defend the implementation merely because inherited context may contain the process that produced it.
Independently evaluate the current repository state against the active ledger task and its acceptance criteria.
Actively look for mistakes, omissions, regressions, incorrect assumptions, inadequate tests, unnecessary scope expansion, and conflicts with project conventions.
Do not edit files or attempt repository mutations. Use the provided repository snapshot and read-only file tools to inspect the implementation.
Do not trust the Implementer's claim that the work is complete. The repository is the source of truth.
Do not request changes purely for subjective style preferences unless established repository conventions require them.
Finish by calling review_result exactly once. Do not merely print a verdict.`;

const IMPLEMENTER_INSTRUCTIONS = `You are the IMPLEMENTER for an active implementation ledger.
The extension controls task sequencing and review. Work only on the currently active ledger task.
Do not create additional ledger tasks, reorder tasks, silently expand task scope, modify the ledger structure, or mark tasks completed yourself.
Inspect the repository and implement the active task. Follow existing repository conventions.
Use the Goal, Scope, Acceptance Criteria, and Notes from the ledger as the task contract.
Run appropriate validation. When you believe the task is ready, call submit_for_review.
A task is complete only after the Reviewer approves it.`;

interface ReviewerHandle {
  taskId: string;
  session: AgentSession;
  round: number;
  getResult: () => ReviewResult | undefined;
  resetResult: () => void;
  tempDir?: string;
}

interface LedgerRuntime {
  ledgerPath: string | null;
  activeTaskId: string | null;
  config: LedgerConfig | null;
  reviewer?: ReviewerHandle;
  reviewRound: number;
  reviewing: boolean;
}

const IssueSchema = Type.Object({
  severity: StringEnum(["critical", "major", "minor"] as const),
  description: Type.String(),
  file: Type.Optional(Type.String()),
  line: Type.Optional(Type.Integer({ minimum: 1 })),
  suggestedFix: Type.Optional(Type.String()),
});

function cleanPathArgument(argument: string): string {
  const trimmed = argument.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function reviewerModel(ctx: ExtensionContext, configured: string | null) {
  if (!configured) {
    const fallback = ctx.model ?? ctx.modelRegistry.getAvailable()[0];
    if (!fallback) throw new Error("no model with configured authentication is available for the Reviewer");
    return fallback;
  }

  const models = ctx.modelRegistry.getAll();
  const canonical = models.filter((model) => `${model.provider}/${model.id}` === configured);
  if (canonical.length === 1) return canonical[0];
  const bare = models.filter((model) => model.id === configured);
  if (bare.length === 1) return bare[0];
  if (bare.length > 1) throw new Error(`ambiguous reviewer.model ${configured}; use Pi's provider/model identifier`);
  throw new Error(`reviewer.model not found: ${configured}`);
}

async function disposeReviewer(handle: ReviewerHandle | undefined): Promise<void> {
  if (!handle) return;
  handle.session.dispose();
  if (handle.tempDir) await rm(handle.tempDir, { recursive: true, force: true });
}

async function repositorySnapshot(pi: ExtensionAPI, cwd: string, signal: AbortSignal | undefined): Promise<string> {
  const status = await pi.exec("git", ["status", "--short"], { cwd, signal, timeout: 10_000 });
  if (status.code !== 0) return "Git metadata is unavailable. Inspect the repository state directly.";

  const unstaged = await pi.exec("git", ["diff", "--no-ext-diff", "--no-color", "--", "."], {
    cwd, signal, timeout: 15_000,
  });
  const staged = await pi.exec("git", ["diff", "--cached", "--no-ext-diff", "--no-color", "--", "."], {
    cwd, signal, timeout: 15_000,
  });
  const combined = [
    `git status --short:\n${status.stdout.trim() || "(clean)"}`,
    `unstaged diff:\n${unstaged.stdout.trim() || "(none)"}`,
    `staged diff:\n${staged.stdout.trim() || "(none)"}`,
  ].join("\n\n");
  const limit = 40_000;
  return combined.length <= limit
    ? combined
    : `${combined.slice(0, limit)}\n\n[Snapshot truncated; inspect the repository directly for the complete state.]`;
}

function reviewPrompt(task: LedgerTask, round: number, retained: boolean, snapshot: string, validation?: string): string {
  const continuation = round > 1
    ? `Continue reviewing the same ledger task. The Implementer has made additional changes.
${retained ? "Use your previous review findings as context. " : "This is a new independent Reviewer context. "}Verify that previously reported issues were actually resolved where that information is available.
Also inspect the updated implementation for regressions or new problems. Do not approve merely because the Implementer says requested changes were addressed.\n\n`
    : "";
  return `${continuation}${formatTask(task)}

Review for correctness, every acceptance criterion, regressions, missing behavior, incorrect assumptions, edge cases, error handling, scope expansion, project conventions, and insufficient or incorrect tests.

Current repository snapshot (it may include pre-existing or unrelated user changes; do not modify or discard them):
${snapshot}

${validation ? `Implementer-reported validation (verify rather than trust it):\n${validation}\n\n` : ""}Return one structured semantic verdict through review_result:
- APPROVED: the task is ready to be completed.
- CHANGES_REQUESTED: include concrete actionable findings.
- BLOCKED: reliable completion or review requires external information or intervention.`;
}

function implementerPrompt(ledgerPath: string, task: LedgerTask, resumed: boolean): string {
  return `[LEDGER] ${ledgerPath}\n[IMPLEMENTER] ${task.id} -- ${task.title}${resumed ? " (resumed)" : ""}\n\n${IMPLEMENTER_INSTRUCTIONS}\n\n${formatTask(task)}`;
}

async function createReviewer(
  ctx: ExtensionContext,
  config: LedgerConfig,
  taskId: string,
): Promise<ReviewerHandle> {
  let captured: ReviewResult | undefined;
  const resultTool = {
    name: "review_result",
    label: "Review Result",
    description: "Return the final structured review verdict for the active ledger task.",
    promptSnippet: "Submit the final structured ledger review verdict",
    promptGuidelines: ["Use review_result exactly once as the final action of every ledger review."],
    parameters: Type.Object({
      verdict: StringEnum(["APPROVED", "CHANGES_REQUESTED", "BLOCKED"] as const),
      summary: Type.String(),
      issues: Type.Array(IssueSchema),
    }),
    async execute(_toolCallId: string, params: unknown) {
      captured = parseReviewResult(params);
      return {
        content: [{ type: "text" as const, text: `Review recorded: ${captured.verdict}` }],
        details: captured,
        terminate: true,
      };
    },
  };

  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPromptOverride: (base) => [...base, REVIEWER_SYSTEM_PROMPT],
  });
  await loader.reload();

  let sessionManager: SessionManager;
  let tempDir: string | undefined;
  if (config.reviewer.initialContext === "inherit") {
    const parentFile = ctx.sessionManager.getSessionFile();
    if (!parentFile) {
      throw new Error("reviewer.initialContext=inherit requires a persisted current Pi session; restart without --no-session or use fresh");
    }
    tempDir = await mkdtemp(join(tmpdir(), "pi-ledger-review-"));
    sessionManager = SessionManager.forkFrom(parentFile, ctx.cwd, tempDir);
  } else {
    sessionManager = SessionManager.inMemory(ctx.cwd);
  }

  try {
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      model: reviewerModel(ctx, config.reviewer.model),
      modelRegistry: ctx.modelRegistry,
      resourceLoader: loader,
      sessionManager,
      tools: ["read", "grep", "find", "ls", "review_result"],
      customTools: [resultTool],
    });
    return {
      taskId,
      session,
      round: 0,
      getResult: () => captured,
      resetResult: () => { captured = undefined; },
      tempDir,
    };
  } catch (error) {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export default function piCodingLoopExtension(pi: ExtensionAPI) {
  const runtime: LedgerRuntime = {
    ledgerPath: null,
    activeTaskId: null,
    config: null,
    reviewRound: 0,
    reviewing: false,
  };

  async function stopReviewer() {
    const reviewer = runtime.reviewer;
    runtime.reviewer = undefined;
    await disposeReviewer(reviewer);
  }

  async function persistStatus(taskId: string, status: "in_progress" | "completed" | "blocked", reason?: string) {
    if (!runtime.ledgerPath) throw new Error("no active ledger");
    await withFileMutationQueue(runtime.ledgerPath, async () => {
      const current = await readFile(runtime.ledgerPath!, "utf8");
      const updated = updateTaskStatus(current, taskId, status, reason);
      await writeFile(runtime.ledgerPath!, updated, "utf8");
    });
  }

  pi.registerCommand("implement-ledger", {
    description: "Execute an existing Markdown implementation ledger",
    handler: async (argument, ctx) => {
      const requestedPath = cleanPathArgument(argument);
      if (!requestedPath) {
        ctx.ui.notify("Usage: /implement-ledger <path>", "warning");
        return;
      }
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Project trust is required to load .pi/ledger.yaml", "error");
        return;
      }

      try {
        await ctx.waitForIdle();
        await stopReviewer();
        const configPath = join(ctx.cwd, CONFIG_DIR_NAME, "ledger.yaml");
        const ledgerPath = isAbsolute(requestedPath) ? requestedPath : resolve(ctx.cwd, requestedPath);
        const [configSource, ledgerSource] = await Promise.all([
          readFile(configPath, "utf8"),
          readFile(ledgerPath, "utf8"),
        ]);
        const config = parseLedgerConfig(configSource);
        let ledger = parseLedger(ledgerSource);
        let task = selectActiveTask(ledger);
        if (!task) {
          runtime.ledgerPath = ledgerPath;
          runtime.activeTaskId = null;
          runtime.config = config;
          ctx.ui.notify(`[LEDGER] ${requestedPath} is finished`, "info");
          return;
        }

        const resumed = task.status === "in_progress";
        runtime.ledgerPath = ledgerPath;
        runtime.activeTaskId = task.id;
        runtime.config = config;
        runtime.reviewRound = 0;
        if (task.status === "pending") {
          await persistStatus(task.id, "in_progress");
          ledger = parseLedger(await readFile(ledgerPath, "utf8"));
          task = ledger.tasks.find((candidate) => candidate.id === task!.id)!;
        }

        ctx.ui.notify(`[LEDGER] ${requestedPath}`, "info");
        ctx.ui.notify(`[IMPLEMENTER] ${task.id} -- ${task.title}${resumed ? " (resumed)" : ""}`, "info");
        pi.sendUserMessage(implementerPrompt(requestedPath, task, resumed));
      } catch (error) {
        runtime.ledgerPath = null;
        runtime.activeTaskId = null;
        runtime.config = null;
        runtime.reviewRound = 0;
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "submit_for_review",
    label: "Submit for Review",
    description: "Submit the active Pi Coding Loop ledger task to its configured independent Reviewer.",
    promptSnippet: "Submit the current Pi Coding Loop task for structured review",
    promptGuidelines: [
      "Use submit_for_review only when the active ledger task is implemented and validated.",
      "Never edit ledger task statuses directly; submit_for_review owns review-driven transitions.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      validationSummary: Type.Optional(Type.String({ description: "Concise validation commands and results, if available" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (runtime.reviewing) throw new Error("a ledger review is already running");
      if (!runtime.ledgerPath || !runtime.activeTaskId || !runtime.config) {
        throw new Error("no active ledger; run /implement-ledger <path> first");
      }

      runtime.reviewing = true;
      try {
        const source = await readFile(runtime.ledgerPath, "utf8");
        const ledger = parseLedger(source);
        const task = ledger.tasks.find((candidate) => candidate.id === runtime.activeTaskId);
        if (!task || task.status !== "in_progress") {
          throw new Error(`active task ${runtime.activeTaskId} is no longer in_progress in the ledger`);
        }

        const create = shouldCreateReviewer(runtime.config.reviewer.contextMode, runtime.reviewer?.taskId, task.id);
        if (create) {
          await stopReviewer();
          runtime.reviewer = await createReviewer(ctx, runtime.config, task.id);
        }
        const reviewer = runtime.reviewer!;
        runtime.reviewRound += 1;
        reviewer.round = runtime.reviewRound;
        reviewer.resetResult();
        const retained = runtime.config.reviewer.contextMode === "retained" && reviewer.round > 1;
        const modelName = `${reviewer.session.model?.provider}/${reviewer.session.model?.id}`;
        onUpdate?.({
          content: [{ type: "text", text: `[REVIEWER] review #${reviewer.round}${retained ? " -- retained context" : ""}\n[REVIEWER] model: ${modelName}` }],
          details: { taskId: task.id, round: reviewer.round, retained, model: modelName },
        });
        ctx.ui.notify(`[REVIEWER] review #${reviewer.round}${retained ? " -- retained context" : ""}`, "info");

        const snapshot = await repositorySnapshot(pi, ctx.cwd, signal);
        await reviewer.session.prompt(reviewPrompt(task, reviewer.round, retained, snapshot, params.validationSummary));
        const result = reviewer.getResult();
        if (!result) {
          const reason = `Reviewer did not return a structured review_result in round ${reviewer.round}`;
          await persistStatus(task.id, "blocked", reason);
          await stopReviewer();
          runtime.activeTaskId = null;
          runtime.reviewRound = 0;
          ctx.ui.notify(`[REVIEWER] BLOCKED -- ${reason}`, "error");
          return {
            content: [{ type: "text", text: `[REVIEWER] BLOCKED\n${reason}\n[LEDGER] ${task.id} marked blocked. Automatic progression stopped.` }],
            details: { verdict: "BLOCKED", reason },
            terminate: true,
          };
        }

        const transition = reviewTransition(result, reviewer.round, runtime.config.reviewer.maxRounds);
        ctx.ui.notify(`[REVIEWER] ${result.verdict}${result.issues.length ? ` -- ${result.issues.length} issue(s)` : ""}`, result.verdict === "APPROVED" ? "info" : "warning");

        if (transition === "continue") {
          if (runtime.config.reviewer.contextMode === "fresh") await stopReviewer();
          return {
            content: [{ type: "text", text: `The Reviewer requested changes to ${task.id}.\n\nSummary: ${result.summary}\n\nReview findings:\n${formatIssues(result.issues)}\n\nContinue working on the same task. Address relevant findings, inspect the repository rather than blindly following suggestions, rerun appropriate validation, and call submit_for_review again when ready.` }],
            details: { ...result, round: reviewer.round, taskId: task.id },
          };
        }

        if (transition === "block") {
          const reason = result.verdict === "BLOCKED"
            ? result.summary
            : `Maximum review rounds (${runtime.config.reviewer.maxRounds}) reached: ${result.summary}`;
          await persistStatus(task.id, "blocked", reason);
          await stopReviewer();
          runtime.activeTaskId = null;
          runtime.reviewRound = 0;
          ctx.ui.notify(`[LEDGER] ${task.id} blocked`, "error");
          return {
            content: [{ type: "text", text: `[REVIEWER] ${result.verdict}\n${reason}\n\n${formatIssues(result.issues)}\n\n[LEDGER] ${task.id} marked blocked. Automatic progression stopped.` }],
            details: { ...result, round: reviewer.round, taskId: task.id, blockedReason: reason },
            terminate: true,
          };
        }

        await persistStatus(task.id, "completed");
        await stopReviewer();
        runtime.reviewRound = 0;
        ctx.ui.notify(`[LEDGER] ${task.id} completed`, "info");

        const updated = parseLedger(await readFile(runtime.ledgerPath, "utf8"));
        const next = updated.tasks.find((candidate) => candidate.status === "pending");
        if (!next) {
          runtime.activeTaskId = null;
          ctx.ui.notify(`[LEDGER] ${basename(runtime.ledgerPath)} finished`, "info");
          return {
            content: [{ type: "text", text: `[REVIEWER] APPROVED\n${result.summary}\n\n[LEDGER] ${task.id} completed. The ledger is finished.` }],
            details: { ...result, round: reviewer.round, taskId: task.id, ledgerFinished: true },
            terminate: true,
          };
        }

        await persistStatus(next.id, "in_progress");
        runtime.activeTaskId = next.id;
        const active = parseLedger(await readFile(runtime.ledgerPath, "utf8")).tasks.find((candidate) => candidate.id === next.id)!;
        ctx.ui.notify(`[IMPLEMENTER] ${active.id} -- ${active.title}`, "info");
        return {
          content: [{ type: "text", text: `[REVIEWER] APPROVED\n${result.summary}\n\n[LEDGER] ${task.id} completed.\n\n${implementerPrompt(runtime.ledgerPath, active, false)}` }],
          details: { ...result, round: reviewer.round, taskId: task.id, nextTaskId: active.id },
        };
      } finally {
        runtime.reviewing = false;
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await stopReviewer();
  });
}
