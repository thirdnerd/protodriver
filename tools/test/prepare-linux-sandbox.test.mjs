import assert from "node:assert/strict";
import test from "node:test";

import { prepareLinuxSandbox } from "../prepare-linux-sandbox.mjs";

test("a working network-isolating bubblewrap probe changes no host setting", async () => {
  const actions = [];
  const result = await prepareLinuxSandbox({
    probe: async () => actions.push("probe"),
    read: async () => { throw new Error("must not read"); },
    disable: async () => { throw new Error("must not disable"); },
    restoreMarker: async () => { throw new Error("must not mark"); },
    report: (line) => actions.push(line),
  });
  assert.deepEqual(result, { apparmorChanged: false });
  assert.match(actions[1], /package smoke remains required/u);
});

test("an AppArmor-caused failure is retried without weakening the smoke and marked for restoration", async () => {
  const actions = [];
  let attempts = 0;
  const result = await prepareLinuxSandbox({
    probe: async () => {
      actions.push("probe");
      if (++attempts === 1) throw new Error("bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted");
    },
    read: async () => { actions.push("read"); return "1"; },
    disable: async () => actions.push("disable"),
    restoreMarker: async () => actions.push("mark restore"),
    report: (line) => actions.push(line),
  });
  assert.deepEqual(result, { apparmorChanged: true });
  assert.deepEqual(actions.filter((action) => ["probe", "read", "disable", "mark restore"].includes(action)),
    ["probe", "read", "disable", "mark restore", "probe"]);
  assert.match(actions.at(-1), /full package smoke still runs unchanged/u);
});

test("an unavailable sandbox fails explicitly when AppArmor is not the cause or adjustment did not help", async () => {
  const probe = async () => { throw new Error("bwrap: loopback: Operation not permitted"); };
  await assert.rejects(prepareLinuxSandbox({
    probe,
    read: async () => "0",
    disable: async () => { throw new Error("must not disable"); },
    report: () => {},
  }), /cannot run isolated package smoke/u);
  let marked = false;
  await assert.rejects(prepareLinuxSandbox({
    probe,
    read: async () => "1",
    disable: async () => {},
    restoreMarker: async () => { marked = true; },
    report: () => {},
  }), /still fails after temporarily disabling AppArmor/u);
  assert.equal(marked, true);
});
