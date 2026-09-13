import path from "node:path";

/** True for a root itself or a descendant, never for a sibling or another drive. */
export function isPathWithin(root, candidate, pathApi = path) {
  const fromRoot = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return fromRoot === ""
    || (fromRoot !== ".."
      && !fromRoot.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(fromRoot));
}
