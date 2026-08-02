import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import https from "node:https";

const MINIAUDIO_VERSION = "0.11.25";
const MINIAUDIO_URL = `https://raw.githubusercontent.com/mackron/miniaudio/${MINIAUDIO_VERSION}/miniaudio.h`;
const MINIAUDIO_SHA256 = "ac7af4de748b7e26b777f37e01cee313a308a7296a3eb080e2906b320cc55c89";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const nativeDir = join(repoRoot, "local-audio", "native");
const vendorPath = join(nativeDir, "miniaudio.h");
const outputDir = join(repoRoot, "local-audio", "bin", `${process.platform}-${process.arch}`);
const outputPath = join(outputDir, process.platform === "win32" ? "vsmux-play-sound.exe" : "vsmux-play-sound");

// CDXC:Agent-notifications 2026-07-31-14:30 Package a native local player so
// notification sounds do not depend on browser autoplay or installed players.
await ensureMiniaudioSource();
await mkdir(outputDir, { recursive: true });
compileNativePlayer();
if (process.platform !== "win32") {
  await chmod(outputPath, 0o755);
}

async function ensureMiniaudioSource() {
  if (!existsSync(vendorPath)) {
    await writeFile(vendorPath, await downloadText(MINIAUDIO_URL), "utf8");
  }

  const hash = createHash("sha256").update(await readFile(vendorPath)).digest("hex");
  if (hash !== MINIAUDIO_SHA256) {
    throw new Error(`Unexpected miniaudio hash: ${hash}`);
  }
}

function compileNativePlayer() {
  const sourcePath = join(nativeDir, "play-sound.c");
  const compiler = process.platform === "win32" ? "cl" : "cc";
  const args = process.platform === "win32"
    ? ["/O2", sourcePath, `/Fe:${outputPath}`]
    : process.platform === "darwin"
      ? [sourcePath, "-O2", "-o", outputPath, "-framework", "CoreAudio", "-framework", "AudioUnit", "-framework", "AudioToolbox", "-framework", "CoreFoundation"]
      : [sourcePath, "-O2", "-o", outputPath, "-lm", "-lpthread", "-ldl"];
  const result = spawnSync(compiler, args, {
    cwd: nativeDir,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        response.resume();
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
    }).on("error", reject);
  });
}
