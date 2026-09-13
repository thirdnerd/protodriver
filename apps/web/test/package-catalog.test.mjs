import assert from "node:assert/strict";
import test from "node:test";
import { installPackageCatalog } from "../src/package-catalog.ts";
import { loadAndRememberPackage } from "../src/package-loading.ts";

const page = "https://example.test/app/index.html";
const discoveryUrl = "https://example.test/app/catalog.json";

function catalog(body, url = discoveryUrl) {
  return { ok: true, status: 200, url, async json() { return JSON.parse(body); } };
}

function packageResponse(bytes, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() { return Uint8Array.from(bytes).buffer; },
  };
}

function harness(fetcher) {
  const calls = [];
  const errors = [];
  const catalogErrors = [];
  const loaded = [];
  const remembered = [];
  const region = { hidden: true };
  const select = {
    options: [], selectedIndex: -1, disabled: true, listener: undefined,
    replaceChildren(...options) { this.options = options; },
    addEventListener(type, listener) { assert.equal(type, "change"); this.listener = listener; },
    choose(index) { this.selectedIndex = index; this.listener(); },
  };
  const view = {
    baseURI: page,
    region,
    select,
    document: { createElement(tag) { assert.equal(tag, "option"); return { textContent: "" }; } },
    async fetcher(url) { calls.push(url); return fetcher(url); },
    beforeLoad() {},
    afterLoad() {},
    async loadBytes(bytes) { loaded.push([...bytes]); remembered.push([...bytes]); },
    onCatalogError(error) { catalogErrors.push(error.message); },
    onEntryError(error) { errors.push(error.message); },
  };
  return { view, calls, errors, catalogErrors, loaded, remembered, region, select };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("absent catalog makes one silent same-origin GET and leaves the dropdown absent", async () => {
  const h = harness(async () => ({ ok: false, status: 404 }));
  await installPackageCatalog(h.view);
  assert.deepEqual(h.calls, [discoveryUrl]);
  assert.equal(h.region.hidden, true);
  assert.deepEqual(h.select.options, []);
  assert.deepEqual(h.catalogErrors, []);
  assert.deepEqual(h.errors, []);
});

test("empty conforming catalog looks like absence without reporting an error", async () => {
  const absent = harness(async () => ({ ok: false, status: 404 }));
  const empty = harness(async () => catalog('{"packages":[]}'));
  await installPackageCatalog(absent.view);
  await installPackageCatalog(empty.view);
  for (const h of [absent, empty]) {
    assert.deepEqual(h.calls, [discoveryUrl]);
    assert.equal(h.region.hidden, true);
    assert.equal(h.select.disabled, true);
    assert.deepEqual(h.select.options, []);
    assert.deepEqual(h.catalogErrors, []);
    assert.deepEqual(h.errors, []);
  }
});

test("a catalog request rejected by the browser is also silent", async () => {
  const h = harness(async () => { throw new TypeError("network failed"); });
  await installPackageCatalog(h.view);
  assert.deepEqual(h.calls, [discoveryUrl]);
  assert.equal(h.region.hidden, true);
  assert.deepEqual(h.catalogErrors, []);
});

test("conforming catalog shows exactly every name, not URL or metadata", async () => {
  const h = harness(async () => catalog('{"annotation":"ignored","packages":[{"name":"Alpha","url":"a.pdpkg","digest":"ignored"},{"name":"Beta","url":"b.pdpkg"}]}'));
  await installPackageCatalog(h.view);
  assert.equal(h.region.hidden, false);
  assert.equal(h.select.disabled, false);
  assert.equal(h.select.selectedIndex, -1);
  assert.deepEqual(h.select.options.map(option => option.textContent), ["Alpha", "Beta"]);
  assert.deepEqual(h.calls, [discoveryUrl]);
});

test("a 2xx malformed catalog names its URL and leaves no dropdown", async () => {
  const h = harness(async () => catalog('{"packages":"not an array"}'));
  await installPackageCatalog(h.view);
  assert.equal(h.region.hidden, true);
  assert.deepEqual(h.select.options, []);
  assert.match(h.catalogErrors[0], /https:\/\/example\.test\/app\/catalog\.json/u);
});

test("a 2xx non-JSON catalog is also reported as invalid", async () => {
  const h = harness(async () => catalog("not JSON"));
  await installPackageCatalog(h.view);
  assert.equal(h.region.hidden, true);
  assert.match(h.catalogErrors[0], /Package catalog https:\/\/example\.test\/app\/catalog\.json is invalid/u);
});

test("one missing url refuses the entire catalog, including its valid entry", async () => {
  const h = harness(async () => catalog('{"packages":[{"name":"Valid","url":"valid.pdpkg"},{"name":"Broken"}]}'));
  await installPackageCatalog(h.view);
  assert.equal(h.region.hidden, true);
  assert.deepEqual(h.select.options, []);
  assert.equal(h.catalogErrors.length, 1);
});

test("relative entry resolves against the final catalog URL, not the page", async () => {
  const entryUrl = "https://example.test/deploy/catalogs/device.pdpkg";
  const h = harness(async url => url === discoveryUrl
    ? catalog('{"packages":[{"name":"Nested","url":"device.pdpkg"}]}', "https://example.test/deploy/catalogs/catalog.json")
    : packageResponse([1, 2, 3]));
  await installPackageCatalog(h.view);
  h.select.choose(0);
  await settle();
  assert.deepEqual(h.calls, [discoveryUrl, entryUrl]);
  assert.deepEqual(h.loaded, [[1, 2, 3]]);
});

test("cross-origin package entry is fetched and reaches the shared byte loader", async () => {
  const entryUrl = "https://other.test/packages/remote.pdpkg";
  const h = harness(async url => url === discoveryUrl
    ? catalog('{"packages":[{"name":"Remote","url":"https://other.test/packages/remote.pdpkg"}]}')
    : packageResponse([7, 8]));
  await installPackageCatalog(h.view);
  h.select.choose(0);
  await settle();
  assert.deepEqual(h.calls, [discoveryUrl, entryUrl]);
  assert.deepEqual(h.loaded, [[7, 8]]);
  assert.deepEqual(h.remembered, [[7, 8]]);
});

test("catalog selection and file import share admission and remembering", async () => {
  const saved = [];
  const admitted = [];
  const refreshed = [];
  const statuses = [];
  const dependencies = {
    async loadDeviceBytes(bytes) { admitted.push([...bytes]); return { admission: { kind: "pdpkg" } }; },
    async remember(bytes) { saved.push([...bytes]); return saved.length; },
    async refreshRemembered(id) { refreshed.push(id); },
    setRememberedStatus(message) { statuses.push(message); },
    reportRememberError(error) { throw error; },
  };
  const h = harness(async url => url === discoveryUrl
    ? catalog('{"packages":[{"name":"Catalog","url":"catalog.pdpkg"}]}')
    : packageResponse([4, 5]));
  h.view.loadBytes = bytes => loadAndRememberPackage(bytes, dependencies);
  await installPackageCatalog(h.view);
  h.select.choose(0);
  await settle();
  await loadAndRememberPackage(Uint8Array.of(6, 7), dependencies); // file-import path
  assert.deepEqual(admitted, [[4, 5], [6, 7]]);
  assert.deepEqual(saved, [[4, 5], [6, 7]]);
  assert.deepEqual(refreshed, [1, 2]);
  assert.deepEqual(statuses, ["Remembered as package 1.", "Remembered as package 2."]);
  assert.deepEqual(h.errors, []);
});

test("entry fetch errors name entry and host and distinguish HTTP from browser refusal", async () => {
  const body = '{"packages":[{"name":"Remote","url":"https://other.test/missing.pdpkg"}]}';
  const http = harness(async url => url === discoveryUrl ? catalog(body) : packageResponse([], 503));
  await installPackageCatalog(http.view);
  http.select.choose(0);
  await settle();
  assert.match(http.errors[0], /Remote.*other\.test.*HTTP 503/u);

  const refused = harness(async url => {
    if (url === discoveryUrl) return catalog(body);
    throw new TypeError("Failed to fetch");
  });
  await installPackageCatalog(refused.view);
  refused.select.choose(0);
  await settle();
  assert.match(refused.errors[0], /Remote.*other\.test.*browser refused/u);
  assert.doesNotMatch(refused.errors[0], /HTTP/u);
});
