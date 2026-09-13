export function releaseVersionFromTag(tag) {
  if (typeof tag !== "string" || !/^v0\.(?:[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag)) {
    throw new TypeError("release tag must be semantic v0.MINOR.PATCH, starting at v0.1.0");
  }
  return tag.slice(1);
}

export function validateReleaseVersion(version) {
  if (typeof version !== "string" || !/^0\.(?:[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new TypeError("release version must be semantic 0.MINOR.PATCH, starting at 0.1.0");
  }
  return version;
}

export function releaseManifestFields(version) {
  return version === undefined ? {} : { version: validateReleaseVersion(version) };
}
