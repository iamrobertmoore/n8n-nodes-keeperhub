#!/usr/bin/env node

/**
 * Compares the local package.json version against what's currently published
 * on npm for the appropriate dist-tag, and tells GitHub Actions whether this
 * push should trigger a publish.
 *
 * Mirrors bin/check-version.ts from nillionnetwork/blindfold-ts, ported to
 * plain Node/CommonJS (no tsx, no semver dependency) to match this repo's
 * existing npm/tsc-only toolchain.
 */

const fs = require("node:fs");
const semver = require("semver");
const packageJson = require("../package.json");

async function getNpmVersion(packageName, distTag) {
  const response = await fetch(`https://registry.npmjs.org/${packageName}`);
  if (response.ok) {
    const data = await response.json();
    return (data["dist-tags"] && data["dist-tags"][distTag]) || "0.0.0";
  }
  return "0.0.0";
}

function writeGitHubOutput(key, value) {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(githubOutput, `${key}=${value}\n`);
  }
  console.log(`${key}=${value}`);
}

async function main() {
  // Validate version format
  if (!semver.valid(packageJson.version)) {
    throw new Error(`Invalid version format: ${packageJson.version}`);
  }

  // Determine tag based on pre-release status
  const distTag = semver.prerelease(packageJson.version) ? "next" : "latest";
  const localVersion = packageJson.version;
  const publicVersion = await getNpmVersion(packageJson.name, distTag);
  const localVersionIsHigher = semver.gt(localVersion, publicVersion);

  // Write outputs
  writeGitHubOutput("local_version_is_higher", localVersionIsHigher.toString());
  writeGitHubOutput("local_version", localVersion);
  writeGitHubOutput("published_version", publicVersion);
  writeGitHubOutput("tag", distTag);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
