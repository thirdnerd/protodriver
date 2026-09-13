import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

test("the advertised shared contracts entry point loads under plain Node", async () => {
  await import("@protodriver/contracts");
});

test("every compiler-promised contracts runtime value exists on the Node entry", async () => {
  const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const configPath = ts.findConfigFile(dirname(indexPath), ts.sys.fileExists, "tsconfig.json");
  assert.notEqual(configPath, undefined);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  assert.deepEqual(parsed.errors, []);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const source = program.getSourceFile(indexPath);
  assert.notEqual(source, undefined);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  assert.notEqual(moduleSymbol, undefined);

  const promisedRuntimeExports = checker.getExportsOfModule(moduleSymbol)
    .filter((symbol) => {
      const declaration = (symbol.flags & ts.SymbolFlags.Alias) === 0
        ? symbol
        : checker.getAliasedSymbol(symbol);
      return (declaration.flags & ts.SymbolFlags.Value) !== 0;
    })
    .map(({ name }) => name)
    .sort();
  const runtimeExports = Object.keys(await import("@protodriver/contracts")).sort();

  assert.deepEqual(runtimeExports, promisedRuntimeExports);
});
