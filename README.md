# Pi Coding Loop

A small Pi package that executes an **existing** Markdown implementation ledger with this loop:

```text
current interactive Pi session (IMPLEMENTER)
  -> submit_for_review
  -> task-scoped Reviewer AgentSession
  -> fix/re-review until APPROVED, BLOCKED, or maxRounds
```

It does not plan work, create tasks, schedule a DAG, commit changes, or spawn an Implementer. The current interactive Pi session is always the Implementer.

## Install from GitHub

Install directly as a Pi package:

```bash
pi install git:github.com/krezolekcoder/pi-coding-loop
```

A normal GitHub URL works too:

```bash
pi install https://github.com/krezolekcoder/pi-coding-loop
```

Pin production installations to a release tag when desired:

```bash
pi install git:github.com/krezolekcoder/pi-coding-loop@v0.1.0
```

Install for only the current project with `-l`:

```bash
pi install git:github.com/krezolekcoder/pi-coding-loop@v0.1.0 -l
```

Pi clones the repository, reads the `pi` manifest in `package.json`, installs the runtime `yaml` dependency, and discovers both the extension and bundled skill. Restart Pi after installation. The first run in a project containing Pi resources may ask you to trust that project.

To update or remove an unpinned installation:

```bash
pi update git:github.com/krezolekcoder/pi-coding-loop
pi remove git:github.com/krezolekcoder/pi-coding-loop
```

### Local development installation

```bash
npm install
pi install .
```

Or load only the extension for one run:

```bash
pi -e ./extensions/pi-coding-loop/index.ts
```

## Use

1. Prepare a compatible ledger (see [`examples/implementation-ledger.md`](examples/implementation-ledger.md) or the `ledger-format` skill).
2. Copy [`examples/ledger.yaml`](examples/ledger.yaml) to your project's `.pi/ledger.yaml`, or create it from the configuration below.
3. Start a normal persisted Pi session in the project and run:

```text
/implement-ledger docs/plans/my-feature.md
```

The command validates the ledger, resumes its single `in_progress` task or marks the first `pending` task `in_progress`, and sends that task to the current session. The Implementer calls `submit_for_review` when ready. It may include a concise `validationSummary` tool argument.

Only `APPROVED` changes a task to `completed`. `CHANGES_REQUESTED` leaves it `in_progress`. `BLOCKED`, a malformed/missing structured result, or `CHANGES_REQUESTED` on the last allowed round changes it to `blocked`, writes a concise `Blocked Reason:`, and stops automatic progression.

## Configuration

```yaml
version: 1
reviewer:
  model: null
  initialContext: fresh
  contextMode: retained
  maxRounds: 3
```

- `reviewer.model`: a Pi model reference. Use Pi's normal exact `provider/model-id` form (a unique bare model ID also works). `null` uses the current Implementer model, falling back to Pi's first authenticated model. This never changes the Implementer model.
- `reviewer.initialContext`: `fresh` starts independently with project context files, the task, repository state, and diff. `inherit` uses Pi's native `SessionManager.forkFrom()` to branch the current persisted Implementer session, then explicitly changes the child role to Reviewer.
- `reviewer.contextMode`: `retained` keeps the exact Reviewer `AgentSession` for re-reviews of the same task. `fresh` disposes it and creates a new context for every invocation; `initialContext` is applied to each such invocation.
- `reviewer.maxRounds`: positive number of Reviewer invocations allowed for one task. Approval on the last round still succeeds.

Reviewer retention is task-scoped. A Reviewer is always disposed before the next ledger task begins. Reviewer tools are strictly read-only (`read`, `grep`, `find`, and `ls`, plus the structured result tool). The extension supplies fixed-command Git status/diffs; validation reported by the Implementer is explicitly treated as untrusted evidence.

### Inherited-context limitation

Pi's public native fork requires a persisted parent session. Therefore `initialContext: inherit` reports an error when Pi was started with `--no-session`. Use a normal session or choose `fresh`. Reviewer conversations are intentionally not persisted by this extension across Pi restarts; rerunning `/implement-ledger` reconstructs an interrupted task from the ledger, repository state, project instructions, and diff.

## Ledger format

Required task shape:

```markdown
## TASK-001 -- Task title
Status: pending

### Goal
Concrete outcome.

### Acceptance Criteria
- observable criterion
```

Optional sections are `Scope`, `Notes`, and `Depends On`. Supported states are `pending`, `in_progress`, `completed`, and `blocked`. There may be at most one `in_progress` task. Tasks execute from top to bottom.

The bundled [`ledger-format` skill](skills/ledger-format/SKILL.md) teaches planning agents this output format. It only normalizes a plan; it does not generate or execute one automatically.

## Design invariants

1. Current Pi session = Implementer; no Implementer child is created.
2. Only the Reviewer model is configurable.
3. `initialContext` controls how the first Reviewer context starts.
4. `contextMode` controls whether that context survives another review of the same task.
5. `retained` reuses the same session for every review round of that task.
6. Reviewer context never carries into another task.
7. The Markdown ledger—not chat history—is durable task state.
8. This package executes a plan; it never creates one.

## Publishing on GitHub

No build step is required: Pi loads the TypeScript extension directly. Before pushing:

```bash
npm ci
npm run check
```

Then create the repository and optionally tag the first stable install:

```bash
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin git@github.com:krezolekcoder/pi-coding-loop.git
git push -u origin main
git tag v0.1.0
git push origin v0.1.0
```

The included `.github/workflows/ci.yml` runs tests, type-checking, and package validation on GitHub Actions.

## Validation

```bash
npm run check
```
