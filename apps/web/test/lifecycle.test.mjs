import assert from "node:assert/strict";
import test from "node:test";

import { installBrowserReleaseHooks } from "../src/lifecycle.ts";

class FakeWindow extends EventTarget {}

test("beforeunload starts release once so a duplicate tab can acquire the port", () => {
  const window = new FakeWindow();
  let releases = 0;
  const hooks = installBrowserReleaseHooks({
    window,
    release() { releases += 1; },
  });
  window.dispatchEvent(new Event("beforeunload"));
  window.dispatchEvent(new Event("beforeunload"));
  assert.equal(releases, 1);
  hooks.dispose();
});
