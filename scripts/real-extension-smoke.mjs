import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const args = process.argv.slice(2);

if (args.includes("--help")) {
  console.log("Usage: pnpm run test:real-extension [workspace-path]");
  process.exit(0);
}

if (args.length > 1) {
  fail("Usage: pnpm run test:real-extension [workspace-path]");
}

const workspacePath = resolve(repoRoot, args[0] ?? ".");
if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
  fail(`Workspace directory does not exist: ${workspacePath}`);
}

/**
 * CDXC:Extension-smoke-test 2026-07-29-23:07
 * Manual extension checks run in an isolated VS Code profile so builds cannot
 * alter the user's usual installed extension or editor settings.
 */
const smokeProfileRoot = join(repoRoot, ".tmp", "real-extension-smoke");
const extensionsDirectory = join(smokeProfileRoot, "extensions");
const userDataDirectory = join(smokeProfileRoot, "user-data");
const configuredT3Root = process.env.VSMUX_T3CODE_REPO_ROOT?.trim();
const managedT3Root = resolve(configuredT3Root || join(repoRoot, "..", "t3code-embed"));
const canBuildManagedT3 =
  existsSync(join(managedT3Root, "apps", "web")) &&
  existsSync(join(managedT3Root, "apps", "server"));
if (configuredT3Root && !canBuildManagedT3) {
  fail(`VSMUX_T3CODE_REPO_ROOT is missing apps/web or apps/server: ${managedT3Root}`);
}

/**
 * CDXC:Extension-smoke-test 2026-07-29-23:20
 * Terminal workflow checks remain runnable without the managed T3 source. The
 * launcher announces the omitted provider; VSMUX_T3CODE_REPO_ROOT enables a full build.
 */
const devInstallArgs = [
  join(scriptDir, "dev-install.mjs"),
  ...(canBuildManagedT3 ? [] : ["--skip-t3"]),
];
if (!canBuildManagedT3) {
  console.warn(
    "Managed T3 source is unavailable; this smoke profile excludes T3. Set VSMUX_T3CODE_REPO_ROOT for a full build.",
  );
}

run(process.execPath, devInstallArgs, {
  ...process.env,
  VSMUX_EXTENSIONS_DIR: extensionsDirectory,
});

const codeCli = process.env.VSMUX_CODE_CLI?.trim() || "code";
run(
  codeCli,
  [
    "--extensions-dir",
    extensionsDirectory,
    "--new-window",
    "--user-data-dir",
    userDataDirectory,
    workspacePath,
  ],
  process.env,
);

console.log(`Opened ${workspacePath} with the isolated VSmux test profile.`);

function run(command, commandArgs, env) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env,
    shell: false,
    stdio: "inherit",
  });

  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
