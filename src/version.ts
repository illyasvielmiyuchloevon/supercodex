import { createRequire } from "node:module";

type PackageJson = {
  version?: unknown;
};

const requireFromHere = createRequire(import.meta.url);

export const SUPERCODEX_VERSION = readPackageVersion();

function readPackageVersion(): string {
  for (const candidate of ["../../package.json", "../package.json"]) {
    try {
      const packageJson = requireFromHere(candidate) as PackageJson;
      if (typeof packageJson.version === "string" && packageJson.version.trim()) {
        return packageJson.version;
      }
    } catch {
      // Source tests and published dist resolve package.json from different depths.
    }
  }
  return "0.0.0";
}
