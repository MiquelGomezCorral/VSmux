import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const localAudioRoot = join(repoRoot, "local-audio");

/**
 * CDXC:Agent-notifications 2026-08-02-12:11
 * Each platform-specific UI companion package must contain only its native
 * helper, bundled media, and compiled code; stale local build artifacts must
 * never leak into another platform's VSIX.
 */
await Promise.all([
  rm(join(localAudioRoot, "bin"), { force: true, recursive: true }),
  rm(join(localAudioRoot, "media"), { force: true, recursive: true }),
  rm(join(localAudioRoot, "out"), { force: true, recursive: true }),
]);
await runTsc();
runNativeBuild();
await mkdir(join(localAudioRoot, "media"), { recursive: true });
await cp(join(repoRoot, "media", "sounds"), join(localAudioRoot, "media", "sounds"), {
  force: true,
  recursive: true,
});

function runTsc() {
  const result = spawnSync(process.execPath, [
    join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(localAudioRoot, "tsconfig.json"),
  ], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runNativeBuild() {
  const result = spawnSync(process.execPath, [join(scriptDir, "build-local-audio-native.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
