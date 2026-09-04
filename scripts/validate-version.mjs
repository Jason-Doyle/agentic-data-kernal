import { readFileSync } from "node:fs";

const packageManifest = JSON.parse(
  readFileSync("package.json", "utf8"),
);
const source = readFileSync("src/version.ts", "utf8");
const match = /PACKAGE_VERSION = "([^"]+)"/.exec(source);
if (match?.[1] !== packageManifest.version) {
  throw new Error(
    `src/version.ts ${match?.[1] ?? "missing"} does not match package.json ${packageManifest.version}`,
  );
}
console.log(`Validated source version ${packageManifest.version}`);

