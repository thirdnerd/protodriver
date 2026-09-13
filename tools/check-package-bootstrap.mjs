#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { isPathWithin } from "./path-containment.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parseExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);

export async function checkPackageBootstrap({ sourceDirectory = defaultRoot } = {}) {
  const root = resolve(sourceDirectory);
  const ts = createRequire(join(defaultRoot, "apps/web/package.json"))("typescript");
  const queue = [join(root, "tools/build-package.mjs")];
  const visited = new Set();
  const violations = [];

  for (const path of queue) {
    if (visited.has(path)) continue;
    visited.add(path);
    const contents = await readFile(path, "utf8");
    const kind = extname(path) === ".tsx" ? ts.ScriptKind.TSX
      : extname(path) === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, kind);
    for (const statement of source.statements) {
      let specifier;
      if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
        specifier = statement.moduleSpecifier.text;
      } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier) {
        specifier = statement.moduleSpecifier.text;
      } else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly
          && ts.isExternalModuleReference(statement.moduleReference)) {
        specifier = statement.moduleReference.expression?.text;
      }
      if (specifier === undefined || specifier.startsWith("node:")) continue;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        violations.push(`${relative(root, path)}: static import ${JSON.stringify(specifier)} is not node: or relative`);
        continue;
      }
      const dependency = resolve(dirname(path), specifier);
      if (!isPathWithin(root, dependency)) {
        violations.push(`${relative(root, path)}: relative import escapes the repository: ${JSON.stringify(specifier)}`);
        continue;
      }
      try {
        if (!(await stat(dependency)).isFile()) throw new Error("not a file");
      } catch {
        violations.push(`${relative(root, path)}: static import cannot be resolved: ${JSON.stringify(specifier)}`);
        continue;
      }
      if (parseExtensions.has(extname(dependency))) queue.push(dependency);
    }
  }
  return Object.freeze({ files: [...visited].map((path) => relative(root, path)).sort(), violations });
}

if (await isMainModule(import.meta.url)) {
  const result = await checkPackageBootstrap();
  for (const violation of result.violations) process.stderr.write(`${violation}\n`);
  if (result.violations.length) process.exitCode = 1;
  else process.stdout.write(`package-bootstrap: ${result.files.length} statically reachable modules checked; OK\n`);
}
