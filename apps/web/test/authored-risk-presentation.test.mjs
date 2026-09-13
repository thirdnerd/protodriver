import assert from "node:assert/strict";
import test from "node:test";

import { renderAuthoredCliHelp } from "../../../packages/generated-cli/src/index.ts";
import { authoredRiskPresentation } from "../src/authored-risk.ts";

test("the authored browser panel and CLI preserve elevated declared risk", () => {
  const description = {
    apiVersion: "device/v2", id: "risk-control", modes: ["service"], profiles: ["serial"],
    operations: [{ id: "rewrite", title: "Rewrite target", binding: "rewrite", arguments: {}, result: { kind: "none" },
      risk: "firmware", repeatability: "not-repeatable", locks: [], requires: [],
      availability: { modes: ["service"], profiles: ["serial"] } }],
  };
  const cli = renderAuthoredCliHelp(description, "rewrite");
  assert.match(cli, /^Risk: firmware$/mu);
  assert.match(cli, /^Repeatability: not-repeatable$/mu);

  const web = authoredRiskPresentation(description.operations[0]);
  assert.equal(web.articleClass, "operation risk-firmware");
  assert.equal(web.badge, "Risk: firmware");
  assert.equal(web.repeatability, "Not repeatable");
  assert.equal(authoredRiskPresentation({ risk: "read-only", repeatability: "safe-to-repeat" }).badge, null);
});
