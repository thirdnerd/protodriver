import assert from "node:assert/strict";
import test from "node:test";

import {
  formatGeneratedHumanBase64Bytes,
  formatGeneratedHumanBytes,
  formatGeneratedHumanUnitValue,
  stringifyGeneratedPublicJson,
} from "../src/index.ts";
import { divideExactDecimal } from "../src/exact-decimal.ts";

test("public JSON renders bytes, exact integers, and flags generically", () => {
  assert.equal(
    stringifyGeneratedPublicJson({ bytes: Uint8Array.of(0, 1, 254, 255), count: 9n, flags: new Set(["z", "a"]) }),
    '{"bytes":{"type":"bytes","encoding":"base64","value":"AAH+/w=="},"count":{"type":"u64","value":"9"},"flags":["a","z"]}',
  );
});

test("fixed human units scale exact decimal values without device knowledge", () => {
  const unit = (id) => ({ kind: "fixed", id });
  assert.equal(formatGeneratedHumanUnitValue("462562500", unit("hertz")), "462.5625 MHz");
  assert.equal(formatGeneratedHumanUnitValue("153600", unit("byte")), "150 KiB");
  assert.equal(formatGeneratedHumanUnitValue("2500", unit("centidegree-celsius")), "25 °C");
  assert.equal(formatGeneratedHumanUnitValue("3300", unit("millivolt")), "3.3 V");
  assert.equal(formatGeneratedHumanUnitValue("885", unit("tenth-hertz")), "88.5 Hz");
  assert.equal(formatGeneratedHumanUnitValue("100000", unit("microsecond")), "0.1 s");
  assert.equal(formatGeneratedHumanUnitValue("250", unit("millisecond")), "0.25 s");
});

test("opaque byte formatting distinguishes inspectable octets from extent", () => {
  assert.equal(formatGeneratedHumanBytes(Uint8Array.of(0, 1, 2, 255)), "hex 00 01 02 ff");
  assert.equal(formatGeneratedHumanBytes(new Uint8Array(9)), "9 B");
  assert.equal(formatGeneratedHumanBytes(new Uint8Array(4096)), "4 KiB");
  assert.equal(formatGeneratedHumanBase64Bytes("AQI="), "hex 01 02");
  assert.equal(formatGeneratedHumanBase64Bytes("AAAAAAAAAAAA"), "9 B");
});

test("exact decimal division refuses non-terminating results", () => {
  assert.equal(divideExactDecimal({ coefficient: 3n, decimalPlaces: 0 }, 2n), "1.5");
  assert.throws(
    () => divideExactDecimal({ coefficient: 1n, decimalPlaces: 0 }, 3n),
    /terminating decimal denominator containing only factors 2 and 5/u,
  );
});
