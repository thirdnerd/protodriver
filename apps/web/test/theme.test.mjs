import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const headEnd = html.indexOf("</head>");
const scriptMatch = /<script>([\s\S]*?)<\/script>/u.exec(html.slice(0, headEnd));
assert.notEqual(scriptMatch, null, "theme initializer is a blocking classic script in head");
const themeScript = scriptMatch[1];

test("theme authority initializes before styles and assigns one native-widget scheme per state", () => {
  assert.ok(html.indexOf("<script>") < html.indexOf('<link rel="stylesheet"'));
  assert.match(
    html,
    /<button id="theme-toggle"[^>]*aria-label="Switch color theme"[^>]*title="Switch color theme"><\/button>/u,
  );
  assert.doesNotMatch(styles, /prefers-color-scheme/u);
  assert.match(styles, /:root \{[^}]*color-scheme: dark;/su);
  assert.match(styles, /:root\[data-theme="light"\] \{[^}]*color-scheme: light;/su);
});

test("the blocking theme initializer follows first-visit preference and persists either explicit choice", () => {
  const firstDark = executeTheme({ prefersLight: false });
  assert.equal(firstDark.documentElement.dataset.theme, "dark");
  assert.equal(firstDark.button.textContent, "sun");
  firstDark.click();
  assert.equal(firstDark.documentElement.dataset.theme, "light");
  assert.equal(firstDark.button.textContent, "moon");
  assert.deepEqual(firstDark.writes, [["protodriver-theme", "light"]]);

  const reloaded = executeTheme({ prefersLight: false, storedTheme: "light" });
  assert.equal(reloaded.documentElement.dataset.theme, "light", "stored choice overrides the system on reload");
  assert.equal(reloaded.button.textContent, "moon");

  const firstLight = executeTheme({ prefersLight: true });
  assert.equal(firstLight.documentElement.dataset.theme, "light");
  assert.equal(firstLight.button.textContent, "moon");
  firstLight.click();
  assert.equal(firstLight.documentElement.dataset.theme, "dark");
  assert.equal(firstLight.button.textContent, "sun");
  assert.deepEqual(firstLight.writes, [["protodriver-theme", "dark"]]);
});

test("storage failure does not prevent the selected theme applying for this page view", () => {
  const result = executeTheme({ prefersLight: false, throwOnRead: true, throwOnWrite: true });
  assert.equal(result.documentElement.dataset.theme, "dark");
  assert.doesNotThrow(result.click);
  assert.equal(result.documentElement.dataset.theme, "light");
  assert.equal(result.button.textContent, "moon");
});

function executeTheme({ prefersLight, storedTheme, throwOnRead = false, throwOnWrite = false }) {
  const documentElement = { dataset: {} };
  let domReady;
  let click;
  const button = {
    dataset: {},
    textContent: "",
    addEventListener(type, listener) {
      assert.equal(type, "click");
      click = listener;
    },
  };
  class HTMLButtonElement {}
  Object.setPrototypeOf(button, HTMLButtonElement.prototype);
  const document = {
    documentElement,
    addEventListener(type, listener, options) {
      assert.equal(type, "DOMContentLoaded");
      assert.equal(options.once, true);
      domReady = listener;
    },
    getElementById(id) {
      assert.equal(id, "theme-toggle");
      return button;
    },
  };
  const writes = [];
  runInNewContext(themeScript, {
    document,
    HTMLButtonElement,
    localStorage: {
      getItem(key) {
        assert.equal(key, "protodriver-theme");
        if (throwOnRead) throw new Error("storage unavailable");
        return storedTheme ?? null;
      },
      setItem(key, value) {
        if (throwOnWrite) throw new Error("storage unavailable");
        writes.push([key, value]);
      },
    },
    matchMedia(query) {
      assert.equal(query, "(prefers-color-scheme: light)");
      return { matches: prefersLight };
    },
  });
  assert.equal(typeof domReady, "function");
  domReady();
  assert.equal(typeof click, "function");
  return { button, click, documentElement, writes };
}
