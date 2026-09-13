import assert from "node:assert/strict";
import test from "node:test";
import { NativeRunway } from "../src/native-runway.ts";
import { NativeHelperData } from "../src/native-helper.ts";
import { activeNativeScratch } from "@protodriver/lua-vm/retained";

function account(maximum = 100) {
  let reserved = 0, spent = 0;
  const data = new NativeHelperData(4096);
  const runway = new NativeRunway(data,
    n => { if (spent + reserved + n > maximum) throw new Error("work exhausted"); reserved += n; },
    n => { reserved -= n; spent += n; }, n => { reserved -= n; }, "operation");
  return { runway, data, get reserved() { return reserved; }, get spent() { return spent; },
    ordinary(n) { if (n > maximum - spent - reserved) throw new Error("work exhausted"); spent += n; } };
}

test("terminal reservation withholds ordinary authority, spends actual work and never refunds spent work", () => {
  const a = account();
  a.runway.ensure(20, 1024);
  assert.equal(a.spent, 0);
  a.ordinary(80);
  assert.throws(() => a.ordinary(1), /work exhausted/);
  a.runway.run(() => { activeNativeScratch().work(7); activeNativeScratch().reserve(900); });
  assert.equal(a.spent, 87); assert.equal(a.reserved, 13);
  a.runway.close();
  assert.equal(a.spent, 87); assert.equal(a.reserved, 0);
  a.ordinary(13); assert.throws(() => a.ordinary(1), /work exhausted/);
});

test("unresolved completion keeps capacity unavailable until its terminal owner closes", () => {
  const a = account();
  a.runway.ensure(20, 2048);
  // Revoking ordinary authority is not a release of a native promise's store.
  a.ordinary(80);
  assert.throws(() => a.data.reserve(2048), e => e.error?.code === "retained.helper-data-exhausted");
  a.runway.run(() => { activeNativeScratch().reserve(1800); activeNativeScratch().work(2); });
  assert.throws(() => a.data.reserve(2048), e => e.error?.code === "retained.helper-data-exhausted");
  a.runway.close();
  a.data.reserve(4000).release();
});

test("failed capacity reservation returns only the unspent work reservation", () => {
  const a = account(); a.ordinary(1);
  assert.throws(() => a.runway.ensure(90, 4096), e => e.error?.code === "retained.helper-data-exhausted");
  assert.equal(a.spent, 1); assert.equal(a.reserved, 0);
  a.ordinary(99); a.runway.close();
});

test("underestimated terminal work or capacity fails before the callback publishes", () => {
  const a = account(); a.runway.ensure(2, 100);
  let published = false;
  assert.throws(() => a.runway.run(() => { activeNativeScratch().work(3); published = true; }), /underestimated/);
  assert.throws(() => a.runway.run(() => { activeNativeScratch().reserve(17); published = true; }), /underestimated/);
  assert.equal(published, false); assert.equal(a.spent, 0); a.runway.close();
});
