import assert from "node:assert/strict";
import test from "node:test";

import { generateAuthoredResultControl } from "../../../packages/control-model/src/authored.ts";
import { renderAuthoredResult } from "../../../packages/generated-web/src/index.ts";

test("the live authored result renderer preserves units and escapes device text", () => {
  const control = generateAuthoredResultControl({kind:"record", fields:{
    temperature:{kind:"integer", widthBits:16, signed:true, unit:{kind:"fixed",id:"centidegree-celsius"}},
    label:{kind:"string"},
  }});
  const html = renderAuthoredResult(control, {temperature:2500, label:"<script>"});
  assert.match(html, /25 °C/u);
  assert.match(html, /&lt;script&gt;/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.throws(() => renderAuthoredResult(control, []), /record required/u);
});
