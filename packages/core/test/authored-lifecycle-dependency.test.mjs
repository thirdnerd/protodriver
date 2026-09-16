import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { admitAuthoredModule } from "../src/authored-module.ts";
import { admitAuthoredDescription } from "../src/authored-admission.ts";

// connection.lifecycle is unavailable without an invalidation binding, and the runtime
// refuses it at operation start. Four declaration sites can require the capability, so
// a package which names it anywhere without an invalidation binding is admissible and
// unrunnable until the operator reaches the operation. The dependency is static at all
// four, and device-1 is the one source declaring enough distinct bindings to reach them.

const artifact = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const bootstrap = new TextEncoder().encode(JSON.stringify({packageFormat:1,generatorContract:2}));

async function deviceOne() {
  const lua = await Promise.all(["device.lua","channel-wire.lua","channel-layout.lua"].map(async logicalName =>
    ({logicalName, sourceBytes: new Uint8Array(await readFile(new URL("../../../corpus/device-1/" + logicalName, import.meta.url)))})));
  return admitAuthoredModule([{logicalName:"pdpkg.json", sourceBytes: bootstrap}, ...lua], artifact);
}

const LIFECYCLE = "connection.lifecycle";
const without = requires => requires.filter(requirement => requirement !== LIFECYCLE);

function strip(description) {
  if (description.entry) description.entry.requires = without(description.entry.requires);
  for (const operation of description.operations) {
    operation.requires = without(operation.requires);
    if (operation.cleanup) operation.cleanup.requires = without(operation.cleanup.requires);
    if (operation.reentry) operation.reentry.requires = without(operation.reentry.requires);
  }
}

const sites = {
  "operation.requires": d => { d.operations[0].requires = [...d.operations[0].requires, LIFECYCLE]; },
  "cleanup.requires": d => { const o = d.operations.find(o => o.cleanup); o.cleanup.requires = [...o.cleanup.requires, LIFECYCLE]; },
  "reentry.requires": d => { const o = d.operations.find(o => o.reentry); o.reentry.requires = [...o.reentry.requires, LIFECYCLE]; },
  "entry.requires": d => { d.entry.requires = [...d.entry.requires, LIFECYCLE]; },
};

test("connection.lifecycle without an invalidation binding is refused at every declaration site", {timeout:5000}, async t => {
  const module = await deviceOne();
  assert.ok(module.description.entry, "device-1 must declare entry for this to be the case under test");
  assert.ok(module.description.operations.some(o => o.cleanup), "device-1 must declare a cleanup");
  assert.ok(module.description.operations.some(o => o.reentry), "device-1 must declare a reentry");

  for (const [site, place] of Object.entries(sites)) {
    await t.test(site, () => {
      const d = structuredClone(module.description);
      delete d.invalidation;
      strip(d);
      place(d);
      assert.throws(() => admitAuthoredDescription(d, module.bindings),
        error => error.code === "authored.declaration.invalid",
        site + " must be refused at admission, not at operation start");
    });
  }
});

// A capability name is an ordinary identifier at admission, so a misspelling is a
// declaration nothing can satisfy. cleanup.requires is already checked against an
// allow-list; the other three sites are not, and a typo there surfaces only when an
// operator runs the operation and reads that some unnamed capability was unavailable.

test("an unknown capability name is refused at admission", {timeout:5000}, async t => {
  const module = await deviceOne();
  const sites = {
    "operation.requires": d => { d.operations[0].requires = [...d.operations[0].requires, "channel.raed"]; },
    "reentry.requires": d => { const o = d.operations.find(o => o.reentry); o.reentry.requires = [...o.reentry.requires, "channel.raed"]; },
    "entry.requires": d => { d.entry.requires = [...d.entry.requires, "channel.raed"]; },
    "cleanup.requires": d => { const o = d.operations.find(o => o.cleanup); o.cleanup.requires = [...o.cleanup.requires, "channel.raed"]; },
  };
  for (const [site, place] of Object.entries(sites)) {
    await t.test(site, () => {
      const d = structuredClone(module.description);
      place(d);
      assert.throws(() => admitAuthoredDescription(d, module.bindings),
        error => error.code === "authored.declaration.invalid",
        site + " must reject a capability name no host can grant");
    });
  }
});
