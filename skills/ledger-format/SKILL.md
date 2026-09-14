---
name: ledger-format
description: Normalize an implementation plan into the Markdown ledger format executed by the Pi Coding Loop extension. Use when a planning task should produce or revise a compatible ledger.
---

# Implementation Ledger Format

This skill defines the output format of an implementation plan. It does not perform execution and does not require planning to begin from a high-level feature request.

Use it to normalize plans derived from a high-level feature, detailed technical specification, research notes, architectural plan, or an already partially decomposed implementation plan. Do not execute the ledger while applying this skill.

## Document structure

Start with a descriptive level-one heading, normally:

```markdown
# Implementation Ledger
```

Write tasks in intended execution order. Every task uses a unique stable ID and this shape:

```markdown
## TASK-001 -- Concise task title
Status: pending

### Goal
A concrete statement of the outcome this task must achieve.

### Scope
Optional boundaries, included only when useful.

### Acceptance Criteria
- an observable, verifiable condition
- another observable, verifiable condition

### Notes
Optional implementation constraints or relevant references.

### Depends On
Optional earlier task IDs when useful for clarity.
```

## Rules

- Use IDs such as `TASK-001`, `TASK-002`, in document order.
- New tasks always start with exactly `Status: pending`.
- `Goal` is required and must be non-empty.
- `Acceptance Criteria` is required and must contain at least one Markdown list item.
- `Scope`, `Notes`, and `Depends On` are optional; omit empty sections.
- Keep criteria testable against repository behavior or other concrete artifacts.
- Choose task granularity that permits one coherent implementation and review cycle. Split work when tasks have independent outcomes; do not split into trivial file-by-file edits.
- Preserve constraints and exclusions from the source material. Do not invent scope merely to fill the format.
- Order tasks sequentially so earlier tasks establish prerequisites for later tasks.
- Do not add model or execution configuration to the ledger; that belongs in `.pi/ledger.yaml`.
