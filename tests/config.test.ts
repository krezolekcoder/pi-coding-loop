import assert from "node:assert/strict";
import test from "node:test";
import { parseLedgerConfig } from "../extensions/pi-coding-loop/config.ts";

test("applies the documented reviewer defaults", () => {
  assert.deepEqual(parseLedgerConfig("version: 1\n"), {
    version: 1,
    reviewer: { model: null, initialContext: "fresh", contextMode: "retained", maxRounds: 3 },
  });
});

test("parses all supported reviewer settings", () => {
  assert.deepEqual(parseLedgerConfig(`version: 1
reviewer:
  model: anthropic/claude-example
  initialContext: inherit
  contextMode: fresh
  maxRounds: 5
`), {
    version: 1,
    reviewer: { model: "anthropic/claude-example", initialContext: "inherit", contextMode: "fresh", maxRounds: 5 },
  });
});

test("rejects unsupported settings values", () => {
  assert.throws(() => parseLedgerConfig("version: 2\n"), /version/);
  assert.throws(() => parseLedgerConfig("version: 1\nreviewer:\n  contextMode: forever\n"), /contextMode/);
  assert.throws(() => parseLedgerConfig("version: 1\nreviewer:\n  maxRounds: 0\n"), /positive integer/);
});
