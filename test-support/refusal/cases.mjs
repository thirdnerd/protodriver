import { refusalCase } from "./case.mjs";
const core = "packages/core/test/";
const body = (id, file, name, grant, mutations, prefix, position, complete) =>
  refusalCase({ id, file: core + file + ".test.mjs", name, grant, mutations, kind: "body", prefix, position, complete });
export const worker = body("worker", "native-helper",
  "native worker wire cannot bypass loop charges into a public work result", 3000, ["helper"],
  o => o.prefix && o.alphabet && o.filled >= 32, o => o.filled <= worker.grant, o => o.alphabet && o.filled === 8192);
export const caught = body("caught", "native-helper",
  "default work account refuses inside a native body after its prefix, even after catch", 32000000, ["helper"],
  o => o.filled >= 8192 && o.exact, o => o.filled <= caught.grant, o => o.filled === caught.grant + 8192);
export const nested = body("nested", "native-helper",
  "nested helper and its resumed parent spend one activation account", 100000, ["helper", "freshHelper"],
  o => o.parent === 40000 && o.child === 40000 && o.late > 0,
  o => o.parent + o.child + o.late <= nested.grant,
  o => o.parent === 40000 && o.child === 40000 && o.late === 40000);
export const continuation = body("continuation", "native-helper",
  "continuation suspension cannot reset native work allowance", 100000, ["helper", "freshHelper"],
  o => o.filled > 80000, o => o.filled <= continuation.grant, o => o.filled === 120000);
export const routed = body("routed", "retained-helper-scheduling",
  "routed helper native iterations remain on the operation's cumulative account", 100000, ["helper", "freshRouted"],
  o => o.output[0] === 50000 && o.output[1] >= 1024,
  o => o.output.reduce((a,b) => a+b,0) <= routed.grant,
  o => o.output.every(n => n === 50000) && o.value === "ABC");
export const copy = body("copy", "source-materialization",
  "native copy capacity and cumulative work refuse before binding writes", 11000, ["copy"],
  o => o.readBytes >= 512, o => o.readBytes < 32768 && !o.complete,
  o => o.complete && o.exact);
export const relay = body("relay", "write-relay",
  "C2 refuses without native bytes: work-both", 50000, ["relay", "equality"],
  o => o.foreground && o.authorizer, o => o.writes.length === 0,
  o => JSON.stringify(o.writes) === JSON.stringify([[81,85,69,82,89,13,10]]) && o.value === "message:reply:OK");
export const binary = refusalCase({ id: "binary", kind: "body", grant: 3450,
  file: "tools/refusal/binary.test.mjs", name: "F binary qualified body on the retained host",
  mutations: ["binary"],
  prefix: o => o.blocks >= 1 && o.valid,
  position: o => !o.complete && o.blocks <= Math.floor(binary.grant / 73) && o.writes.length === 0,
  complete: o => o.blocks === 64 && o.valid && o.complete,
});
export const scheduled = refusalCase({ id: "scheduled", kind: "body", grant: 8000,
  file: "tools/refusal/scheduled.test.mjs", name: "scheduled helpers refuse bounded body work after handback and routed input",
  mutations: ["helper"],
  prefix: o => o.first === 32 && o.last >= 32 && o.valid && o.alarm && o.reply === "OK",
  position: o => o.first + o.last <= scheduled.grant,
  complete: o => o.first === 32 && o.last === 19968 && o.value === "OK",
});
export const subdivision = refusalCase({ id: "subdivision", kind: "conservation", grant: 75791,
  file: core + "handler-delivery.test.mjs", name: "D2 subdivision work is charged before the next native effect",
  mutations: ["subdivision"],
  reason: "One subdivision unit accompanies each real Lua dispatch, whose mandatory ABI work is larger. Increasing the range adds both costs; subdivision cannot dominate. Observe actual authority consumption on the same delivery account, with a real first write and a suspended second body.",
  conservation: {units:1,rule:"D2: each subdivision spends one unit on the original delivery account before handler preparation.",
    observations:o=>o.debits},
  prefix: o => o.writes.length >= 1 && o.writes[0].length === 256 && o.writes[0].every(n => n === 0) && o.resumed && o.debits.length === 2,
  position: o => o.writes.length === 1,
  complete: () => false,
});
