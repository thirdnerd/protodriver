import assert from "node:assert/strict";
import test from "node:test";
import { authoredOperationErrorText } from "../src/authored-controls.ts";

// A per-operation failure is rendered into the operation own output area and never
// reaches the top-level error panel, so whatever this produces is the whole of what
// the operator is shown. A structured fault carries the fields which say what was
// refused and what would satisfy it; dropping them leaves an unactionable sentence.

test("a structured fault keeps its code and its details, not only its message", () => {
  const text = authoredOperationErrorText({ error: {
    code: "authored.capability.unavailable",
    message: "required capability unavailable before operation start",
    details: { requirement: "connection.lifecycle", limitation: "requires an admitted invalidation handler", started: false },
  }});
  assert.match(text, /required capability unavailable before operation start/u);
  assert.match(text, /authored\.capability\.unavailable/u);
  assert.match(text, /connection\.lifecycle/u, "the refused requirement must be named");
  assert.match(text, /requires an admitted invalidation handler/u, "the limitation says what would satisfy it");
});

test("an ordinary error still renders its message", () => {
  assert.match(authoredOperationErrorText(new Error("load a device before using the session")),
    /load a device before using the session/u);
});
