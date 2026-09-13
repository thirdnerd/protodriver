import assert from "node:assert/strict";
import test from "node:test";

import {
  readNodeUsbCandidateHostEvidence,
  usbSpeedEvidenceFromSysfs,
} from "../src/node-authored-candidates.ts";

test("non-Linux USB discovery carries unreported speed without touching sysfs", async () => {
  for (const hostPlatform of ["darwin", "win32"]) {
    let reads = 0;
    const evidence = await readNodeUsbCandidateHostEvidence(
      hostPlatform,
      "3-1.2",
      async () => {
        reads += 1;
        throw new Error("non-Linux discovery attempted a sysfs read");
      },
    );
    assert.equal(reads, 0);
    assert.deepEqual(evidence, {
      portPath: "usb:3-1.2",
      speedEvidence: { kind: "unreported" },
    });
  }
});

test("Linux USB discovery retains reported sysfs evidence", async () => {
  const observed = [];
  const values = new Map([
    ["product", "TI-84 Plus CE"],
    ["speed", "480"],
    ["serial", "fixture-serial"],
  ]);
  const evidence = await readNodeUsbCandidateHostEvidence(
    "linux",
    "1-2.3",
    async (root, name) => {
      observed.push([root, name]);
      return values.get(name);
    },
  );
  assert.deepEqual(observed, [
    ["/sys/bus/usb/devices/1-2.3", "product"],
    ["/sys/bus/usb/devices/1-2.3", "speed"],
    ["/sys/bus/usb/devices/1-2.3", "serial"],
  ]);
  assert.deepEqual(evidence, {
    productName: "TI-84 Plus CE",
    serialNumber: "fixture-serial",
    portPath: "/sys/bus/usb/devices/1-2.3",
    speedEvidence: { kind: "reported", speed: "high" },
  });
});

test("missing sysfs speed is unreported while an unsupported observation stays visible", () => {
  assert.deepEqual(usbSpeedEvidenceFromSysfs(undefined), { kind: "unreported" });
  assert.deepEqual(usbSpeedEvidenceFromSysfs("12"), { kind: "reported", speed: "full" });
  assert.throws(
    () => usbSpeedEvidenceFromSysfs("5000"),
    /USB candidate speed "5000" from sysfs is unsupported/u,
  );
});
