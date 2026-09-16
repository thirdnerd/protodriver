#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { isPathWithin } from "./path-containment.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourceRoot = resolve(repositoryRoot, "apps/web/src");
const requireFromWeb = createRequire(resolve(repositoryRoot, "apps/web/package.json"));
let ts;
function loadTypeScript() {
  // Package assembly imports this module before installing workspaces. Resolve
  // the parser only when an offline check actually runs after installation.
  return ts ??= requireFromWeb("typescript");
}
const sourceExtensions = new Set([".html", ".css", ".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const resourceAttributes = new Map([
  ["audio", ["src"]],
  ["base", ["href"]],
  ["embed", ["src"]],
  ["form", ["action"]],
  ["iframe", ["src"]],
  ["img", ["src", "srcset"]],
  ["input", ["src"]],
  ["object", ["data"]],
  ["script", ["src"]],
  ["source", ["src", "srcset"]],
  ["track", ["src"]],
  ["video", ["poster", "src"]],
]);
const fetchedLinkRelations = new Set([
  "apple-touch-icon",
  "dns-prefetch",
  "icon",
  "manifest",
  "modulepreload",
  "preconnect",
  "prefetch",
  "preload",
  "prerender",
  "stylesheet",
]);

function repositoryPath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

export function inspectBrowserHtml(sourceText) {
  const masked = maskComments(sourceText, /<!--[\s\S]*?-->/gu);
  const findings = [];
  for (const tag of masked.matchAll(/<([a-z][a-z0-9:-]*)\b([^>]*)>/giu)) {
    const tagName = tag[1].toLowerCase();
    const attributes = htmlAttributes(tag[2], (tag.index ?? 0) + tag[0].indexOf(tag[2]));
    const names = tagName === "link"
      ? linkLoadsResource(attributes) ? ["href"] : []
      : resourceAttributes.get(tagName) ?? [];
    for (const name of names) {
      const attribute = attributes.get(name);
      if (attribute === undefined) continue;
      const external = externalReference(attribute.value);
      if (external !== undefined) findings.push({
        index: attribute.index,
        sink: `${tagName}[${name}]`,
        reference: external,
      });
    }
  }
  for (const script of masked.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/giu)) {
    const body = script[1];
    const bodyIndex = (script.index ?? 0) + script[0].indexOf(body);
    findings.push(...inspectBrowserScript(body).map((finding) => ({
      ...finding,
      index: bodyIndex + finding.index,
    })));
  }
  for (const style of masked.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) {
    const body = style[1];
    const bodyIndex = (style.index ?? 0) + style[0].indexOf(body);
    findings.push(...inspectBrowserCss(body).map((finding) => ({
      ...finding,
      index: bodyIndex + finding.index,
    })));
  }
  return findings;
}

export function inspectBrowserCss(sourceText) {
  const masked = maskComments(sourceText, /\/\*[\s\S]*?\*\//gu);
  const findings = [];
  const references = [
    ...masked.matchAll(/@import\s+(?:url\(\s*)?["']?([^"'\s);]+)["']?\s*\)?/giu),
    ...masked.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu),
  ];
  for (const match of references) {
    const external = externalReference(match[1]);
    if (external === undefined) continue;
    findings.push({
      index: (match.index ?? 0) + match[0].indexOf(match[1]),
      sink: match[0].startsWith("@import") ? "css @import" : "css url()",
      reference: external,
    });
  }
  return findings;
}

export function inspectBrowserScript(sourceText, path = "browser-source.ts") {
  loadTypeScript();
  const kind = path.endsWith("x") ? ts.ScriptKind.TSX : path.endsWith(".js") || path.endsWith(".mjs")
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, kind);
  const findings = [];
  const xmlHttpRequests = new Set();

  function collectXmlHttpRequests(node) {
    if (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer !== undefined
        && ts.isNewExpression(node.initializer)
        && calledName(node.initializer.expression) === "XMLHttpRequest") {
      xmlHttpRequests.add(node.name.text);
    }
    ts.forEachChild(node, collectXmlHttpRequests);
  }

  function record(node, sink, expression) {
    const reference = staticReference(expression);
    const external = reference === undefined ? undefined : externalReference(reference);
    if (external !== undefined) findings.push({ index: node.getStart(source), sink, reference: external });
  }

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      record(node.moduleSpecifier, "module import", node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node, "dynamic import", node.arguments[0]);
      } else {
        const name = calledName(node.expression);
        if (name === "fetch" || name === "sendBeacon" || name === "register") {
          record(node, name === "register" ? "service worker register" : name, node.arguments[0]);
        } else if (name === "open"
            && ts.isPropertyAccessExpression(node.expression)
            && ts.isIdentifier(node.expression.expression)
            && xmlHttpRequests.has(node.expression.expression.text)) {
          record(node, "XMLHttpRequest.open", node.arguments[1]);
        } else if (name === "importScripts") {
          for (const argument of node.arguments) record(node, "importScripts", argument);
        } else if (name === "setAttribute") {
          const attribute = staticReference(node.arguments[0])?.toLowerCase();
          if (attribute === "src" || attribute === "href" || attribute === "action" || attribute === "data") {
            record(node, `setAttribute(${attribute})`, node.arguments[1]);
          }
        }
      }
    } else if (ts.isNewExpression(node)) {
      const name = calledName(node.expression);
      if (name === "EventSource" || name === "SharedWorker" || name === "WebSocket" || name === "Worker") {
        record(node, `new ${name}`, node.arguments?.[0]);
      }
    }
    ts.forEachChild(node, visit);
  }

  collectXmlHttpRequests(source);
  visit(source);
  return findings;
}

export async function checkBrowserOffline(sourceRoot = defaultSourceRoot) {
  for (const required of ["index.html", "styles.css"]) {
    const path = resolve(sourceRoot, required);
    try {
      if (!(await stat(path)).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`browser-offline: required source ${required} is absent`);
    }
  }
  const { files, assets } = await browserRuntimeSourceFiles(sourceRoot);
  if (files.length === 0) throw new Error("browser-offline: no browser source files discovered");
  const failures = [];
  for (const path of files) {
    const sourceText = await readFile(path, "utf8");
    const extension = extname(path);
    const findings = extension === ".html"
      ? inspectBrowserHtml(sourceText)
      : extension === ".css"
        ? inspectBrowserCss(sourceText)
        : inspectBrowserScript(sourceText, path);
    for (const finding of findings) {
      const position = lineAndColumn(sourceText, finding.index);
      failures.push(
        `${repositoryPath(path)}:${position.line}:${position.column}`
          + ` external runtime dependency ${JSON.stringify(finding.reference)} via ${finding.sink}`,
      );
    }
  }
  return { fileCount: files.length, runtimeAssetCount: assets.length, runtimeAssets: assets, failures };
}

function htmlAttributes(source, baseIndex) {
  const attributes = new Map();
  for (const match of source.matchAll(/([a-z_:][a-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu)) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attributes.set(match[1].toLowerCase(), {
      value,
      index: baseIndex + (match.index ?? 0) + match[0].indexOf(value),
    });
  }
  return attributes;
}

function linkLoadsResource(attributes) {
  const relation = attributes.get("rel")?.value.toLowerCase().split(/\s+/u) ?? [];
  return relation.some((member) => fetchedLinkRelations.has(member));
}

function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function staticReference(expression) {
  if (expression === undefined) return undefined;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNewExpression(expression) && calledName(expression.expression) === "URL") {
    return staticReference(expression.arguments?.[0]);
  }
  return undefined;
}

function externalReference(source) {
  const match = /(?:^|[\s,])((?:(?:https?|wss?|ftp):)?\/\/[^\s,)'";]+)/iu.exec(source.trim());
  return match?.[1];
}

function maskComments(source, pattern) {
  return source.replace(pattern, (comment) => comment.replace(/[^\n]/gu, " "));
}

function lineAndColumn(source, index) {
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files.sort();
}

async function browserRuntimeSourceFiles(sourceRoot) {
  const queue = await sourceFiles(sourceRoot);
  const discovered = new Set(queue);
  const assets = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index];
    if (path.endsWith(".html") || path.endsWith(".css")) continue;
    const sourceText = await readFile(path, "utf8");
    for (const specifier of runtimeModuleSpecifiers(sourceText, path)) {
      if (specifier.startsWith("node:") || externalReference(specifier) !== undefined) continue;
      let dependency;
      try {
        dependency = createRequire(path).resolve(specifier);
      } catch (cause) {
        throw new Error(`browser-offline: cannot resolve runtime import ${JSON.stringify(specifier)} from ${repositoryPath(path)}`, { cause });
      }
      const resolved = resolve(dependency);
      if (!isPathWithin(repositoryRoot, resolved)) continue;
      if (!sourceExtensions.has(extname(resolved))) {
        assets.add(resolved);
        continue;
      }
      if (discovered.has(resolved)) continue;
      discovered.add(resolved);
      queue.push(resolved);
    }
  }
  return { files: queue.sort(), assets: [...assets].sort() };
}

function runtimeModuleSpecifiers(sourceText, path) {
  loadTypeScript();
  const kind = path.endsWith("x") ? ts.ScriptKind.TSX : path.endsWith(".js") || path.endsWith(".mjs")
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, kind);
  const specifiers = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && runtimeImportClause(node.importClause)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && ts.isStringLiteralLike(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return specifiers;
}

function runtimeImportClause(clause) {
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined || clause.namedBindings === undefined || ts.isNamespaceImport(clause.namedBindings)) {
    return true;
  }
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

async function main() {
  const result = await checkBrowserOffline();
  if (result.failures.length !== 0) {
    for (const failure of result.failures) console.error(failure);
    process.exitCode = 1;
    return;
  }
  console.log(
    `browser-offline: ${result.fileCount} authored runtime source files and ${result.runtimeAssetCount} local runtime ${result.runtimeAssetCount === 1 ? "asset" : "assets"} checked; OK`,
  );
}

if (await isMainModule(import.meta.url)) {
  await main();
}
