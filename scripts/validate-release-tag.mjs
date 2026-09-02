import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import semver from "semver";

const tag = process.argv[2];
const packageManifest = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageManifest.version;

if (tag !== `v${version}`) {
  throw new Error(`Tag ${tag} does not match package version ${version}`);
}
if (!semver.valid(version)) {
  throw new Error(`Package version ${version} is not valid semantic versioning`);
}

const targetIsPrerelease = semver.prerelease(version) !== null;
const tags = execFileSync("git", ["tag", "--list", "v*"], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter(Boolean);

for (const existingTag of tags) {
  const existingVersion = existingTag.slice(1);
  if (
    existingTag === tag ||
    !semver.valid(existingVersion) ||
    (semver.prerelease(existingVersion) !== null) !== targetIsPrerelease
  ) {
    continue;
  }
  if (semver.gt(existingVersion, version)) {
    throw new Error(
      `${existingTag} is newer than ${tag} in the same release channel`,
    );
  }
}

console.log(`Validated release tag ${tag}`);
