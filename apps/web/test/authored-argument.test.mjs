import assert from "node:assert/strict";
import test from "node:test";

import {
  authoredArgumentField,
  authoredArgumentHint,
  authoredArgumentValue,
} from "../src/authored-argument.ts";
import { DefaultValueCodec } from "../../../packages/core/src/values.ts";

const codec = new DefaultValueCodec();

// The browser's own expectation of the wire format is worth nothing on its
// own: the page and this test could encode the same wrong belief. Every
// produced value is handed to the codec that will actually receive it.
function accepted(type, raw) {
  const value = authoredArgumentValue({ kind: "value", type }, raw);
  codec.fromPublic(value, type);
  return value;
}

test("each declared argument kind gets a control a person can operate", () => {
  assert.deepEqual(authoredArgumentField({ kind: "value", type: { kind: "boolean" } }), { kind: "checkbox" });
  assert.deepEqual(
    authoredArgumentField({ kind: "value", type: { kind: "enum", members: ["idle", "run"] } }),
    { kind: "select", members: ["idle", "run"] },
  );
  assert.deepEqual(
    authoredArgumentField({ kind: "value", type: { kind: "flags", members: ["write", "erase"] } }),
    { kind: "flags", members: ["erase", "write"] },
  );
  assert.deepEqual(
    authoredArgumentField({ kind: "value", type: { kind: "integer", widthBits: 16, minimum: 0, maximum: 4095 } }),
    { kind: "number", step: "1", minimum: 0, maximum: 4095 },
  );
  assert.deepEqual(
    authoredArgumentField({ kind: "value", type: { kind: "float" } }),
    { kind: "number", step: "any" },
  );
  assert.equal(authoredArgumentField({ kind: "value", type: { kind: "decimal" } }).kind, "text");
  assert.deepEqual(
    authoredArgumentField({ kind: "file", minimumBytes: 1, maximumBytes: 4096 }),
    { kind: "file", minimumBytes: 1, maximumBytes: 4096 },
  );
  // A shape no single control can express stays honest JSON rather than
  // pretending to be a text field for something else.
  assert.equal(
    authoredArgumentField({ kind: "value", type: { kind: "record", fields: { a: { kind: "boolean" } } } }).placeholder,
    "JSON record",
  );
});

test("the value each control produces is one the receiving codec accepts", () => {
  assert.equal(accepted({ kind: "boolean" }, true), true);
  assert.equal(accepted({ kind: "string", maximumLength: 8 }, "ID?"), "ID?");
  assert.equal(accepted({ kind: "enum", members: ["idle", "run"] }, "run"), "run");
  assert.equal(accepted({ kind: "integer", widthBits: 16, minimum: 0, maximum: 4095 }, "2300"), 2300);
  assert.equal(accepted({ kind: "float" }, "21.5"), 21.5);

  // Flags cross the boundary sorted and without duplicates; the codec
  // rejects any other order, so the control must not pass clicks through
  // in the order they happened.
  assert.deepEqual(accepted({ kind: "flags", members: ["erase", "verify", "write"] }, ["write", "erase"]),
    ["erase", "write"]);

  // Hand-typed JSON for a decimal or a byte string is what this replaces.
  assert.deepEqual(accepted({ kind: "decimal" }, " 21.50 "), { type: "decimal", value: "21.50" });
  assert.deepEqual(accepted({ kind: "bytes" }, "41 54 0d 0a"),
    { type: "bytes", encoding: "base64", value: "QVQNCg==" });
  assert.deepEqual(accepted({ kind: "bytes" }, ""), { type: "bytes", encoding: "base64", value: "" });
  assert.deepEqual(accepted({ kind: "bytes" }, "ff"), { type: "bytes", encoding: "base64", value: "/w==" });

  assert.deepEqual(accepted({ kind: "record", fields: { on: { kind: "boolean" } } }, '{"on":true}'), { on: true });
});

test("an integer past exact number range crosses as a tagged integer", () => {
  const unsigned = { kind: "integer", widthBits: 64 };
  assert.deepEqual(accepted(unsigned, "18446744073709551615"),
    { type: "u64", value: "18446744073709551615" });
  const signed = { kind: "integer", widthBits: 64, signed: true };
  assert.deepEqual(accepted(signed, "-9223372036854775808"),
    { type: "i64", value: "-9223372036854775808" });
  // Inside exact range it stays an ordinary number, which is what the codec
  // emits on the way out, so a value can round-trip unchanged.
  assert.equal(accepted(unsigned, "42"), 42);
});

test("bad input is refused with a sentence naming what was expected", () => {
  const refuses = (type, raw, expected) =>
    assert.throws(() => authoredArgumentValue({ kind: "value", type }, raw), expected);
  refuses({ kind: "integer", widthBits: 16 }, "12.5", /whole number/u);
  refuses({ kind: "decimal" }, "about twenty", /decimal such as/u);
  refuses({ kind: "bytes" }, "4", /even number of hex digits/u);
  refuses({ kind: "bytes" }, "zz", /hexadecimal digits/u);
  // Number("") is 0 and Number(" ") is 0, so an unfilled numeric field has to
  // be refused by the mapping rather than left to the required attribute.
  refuses({ kind: "float" }, "", /expected a value/u);
  refuses({ kind: "float" }, "   ", /expected a value/u);
  refuses({ kind: "float" }, "twenty", /finite number/u);
  refuses({ kind: "enum", members: ["idle"] }, "", /expected a value/u);
  refuses({ kind: "integer", widthBits: 16 }, "", /whole number/u);
  refuses({ kind: "record", fields: {} }, "{", /JSON record/u);
});

test("hints describe the declared bound rather than repeating the type name", () => {
  assert.equal(
    authoredArgumentHint({ kind: "value", type: { kind: "integer", widthBits: 16, minimum: 500, maximum: 3500 } }),
    "Whole number, 500 to 3,500.",
  );
  assert.equal(authoredArgumentHint({ kind: "file", minimumBytes: 0, maximumBytes: 65536 }), "0 to 65,536 bytes.");
  assert.equal(authoredArgumentHint({ kind: "value", type: { kind: "enum", members: ["a"] } }), undefined);
});
