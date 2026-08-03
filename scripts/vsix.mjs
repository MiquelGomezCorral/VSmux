import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const validModes = new Set(["package", "install"]);
const profileBuildFlag = "--profile-build";
const buildScriptFlag = "--build-script";
const profileFlag = "--profile";
const allProfilesFlag = "--all-profiles";

function fail(message) {
  if (message) {
    console.error(message);
  }

  process.exit(1);
}

function quoteCmdArg(value) {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function quotePowerShellArg(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function run(command, args, options = {}) {
  const useCmdShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const result = useCmdShim
    ? spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `& ${quotePowerShellArg(command)} ${args.map(quotePowerShellArg).join(" ")}`,
        ],
        {
          cwd: repoRoot,
          stdio: "inherit",
          ...options,
        },
      )
    : spawnSync(command, args, {
        cwd: repoRoot,
        stdio: "inherit",
        shell: false,
        ...options,
      });

  if (result.error) {
    fail(result.error.message);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function getPathEntries() {
  const pathValue = process.env.PATH ?? process.env.Path ?? process.env.path ?? "";
  return pathValue
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
    .filter(Boolean);
}

function resolveFromPath(command) {
  const candidateNames =
    process.platform === "win32" && !/[.][^\\/.]+$/u.test(command)
      ? [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]
      : [command];

  for (const entry of getPathEntries()) {
    for (const candidateName of candidateNames) {
      const candidatePath = join(entry, candidateName);
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return undefined;
}

function resolveCommand(command) {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : undefined;
  }

  const localBinDir = join(repoRoot, "node_modules", ".bin");
  const localCandidates =
    process.platform === "win32"
      ? [
          join(localBinDir, `${command}.cmd`),
          join(localBinDir, `${command}.exe`),
          join(localBinDir, `${command}.bat`),
        ]
      : [join(localBinDir, command)];

  for (const candidate of localCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return resolveFromPath(command);
}

function findFirstAvailableCommand(candidates) {
  for (const candidate of candidates) {
    const resolved = resolveCommand(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function findPackageBinaryPath(packagePrefix, relativePath) {
  const pnpmDir = join(repoRoot, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) {
    return undefined;
  }

  const entries = new Set(readdirSync(pnpmDir));

  const match = [...entries].find((entry) => entry.startsWith(packagePrefix));
  return match ? join(pnpmDir, match, ...relativePath) : undefined;
}

function resolveVsixPath(installerDir, extensionName, extensionVersion, mode) {
  const baseName = `${extensionName}-${extensionVersion}`;
  if (mode === "install") {
    const installPath = join(installerDir, `${baseName}.install.vsix`);
    rmSync(installPath, { force: true });
    return installPath;
  }

  const defaultPath = join(installerDir, `${baseName}.vsix`);

  try {
    rmSync(defaultPath, { force: true });
    return defaultPath;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      const fallbackPath = join(installerDir, `${baseName}-${Date.now()}.vsix`);
      return fallbackPath;
    }

    throw error;
  }
}

function resolveCodeCli() {
  const override = process.env.VSMUX_CODE_CLI?.trim();
  if (override) {
    return override;
  }

  const pathCandidates =
    process.platform === "darwin"
      ? [
          "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
          "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
          "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
          "/Applications/Cursor.app/Contents/Resources/app/bin/code",
          "/Applications/VSCodium.app/Contents/Resources/app/bin/codium",
          `${process.env.HOME}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`,
          `${process.env.HOME}/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code`,
          `${process.env.HOME}/Applications/Cursor.app/Contents/Resources/app/bin/cursor`,
          `${process.env.HOME}/Applications/Cursor.app/Contents/Resources/app/bin/code`,
          `${process.env.HOME}/Applications/VSCodium.app/Contents/Resources/app/bin/codium`,
        ]
      : [];

  const candidates =
    process.platform === "win32"
      ? [
          "code.cmd",
          "code-insiders.cmd",
          "cursor.cmd",
          "cursor-insiders.cmd",
          "codium.cmd",
          "windsurf.cmd",
          "code",
          "code-insiders",
          "cursor",
          "cursor-insiders",
          "codium",
          "windsurf",
        ]
      : ["code", "code-insiders", "cursor", "cursor-insiders", "codium", "windsurf"];

  return findFirstAvailableCommand([...candidates, ...pathCandidates]);
}

/**
 * CDXC:DevInstallation 2026-08-03-08:07 Local development updates must register
 * both VSIXs in Default and every named editor profile so no profile keeps running
 * a stale VSmux version. Profile names come from local storage, not Settings Sync.
 */
function resolveAllProfiles(vscodeCli) {
  const userDataDirectory = getEditorUserDataDirectory(vscodeCli);
  const storagePath = join(userDataDirectory, "globalStorage", "storage.json");
  if (!existsSync(storagePath)) {
    fail(`Could not find editor profiles at ${storagePath}.`);
  }

  let storage;
  try {
    storage = JSON.parse(readFileSync(storagePath, "utf8"));
  } catch {
    fail(`Could not read editor profiles at ${storagePath}.`);
  }

  const namedProfiles = Array.isArray(storage?.userDataProfiles)
    ? storage.userDataProfiles
        .map((profile) => profile?.name)
        .filter((name) => typeof name === "string" && name.length > 0)
    : [];
  return [undefined, ...new Set(namedProfiles)];
}

function getEditorUserDataDirectory(vscodeCli) {
  const editor = getEditorDetails(vscodeCli);
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", editor.applicationName, "User");
  }

  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      editor.applicationName,
      "User",
    );
  }

  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    editor.applicationName,
    "User",
  );
}

function getEditorDetails(vscodeCli) {
  const normalizedCli = vscodeCli.toLowerCase();
  if (normalizedCli.includes("cursor")) {
    return { applicationName: "Cursor", applicationBundleName: "Cursor" };
  }

  if (normalizedCli.includes("insiders")) {
    return {
      applicationName: "Code - Insiders",
      applicationBundleName: "Visual Studio Code - Insiders",
    };
  }

  if (normalizedCli.includes("codium")) {
    return { applicationName: "VSCodium", applicationBundleName: "VSCodium" };
  }

  if (normalizedCli.includes("windsurf")) {
    return { applicationName: "Windsurf", applicationBundleName: "Windsurf" };
  }

  return { applicationName: "Code", applicationBundleName: "Visual Studio Code" };
}

/**
 * CDXC:DevInstallation 2026-08-02-23:15 A local profile install must run while
 * the macOS editor is closed because its extension host can overwrite the
 * profile registry with the stale extension version when it exits.
 */
function ensureEditorIsClosed(vscodeCli) {
  if (process.platform !== "darwin") {
    return;
  }

  const processes = spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  const { applicationName, applicationBundleName } = getEditorDetails(vscodeCli);
  if (processes.error) {
    fail(`Could not check whether ${applicationName} is running: ${processes.error.message}`);
  }

  if (processes.stdout?.includes(`${applicationBundleName}.app/Contents/MacOS/`)) {
    fail(
      `Quit ${applicationName} before installing so it cannot restore a stale profile extension registry.`,
    );
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const mode = process.argv[2];
const profileBuild = process.argv.includes(profileBuildFlag);
const buildScriptFlagIndex = process.argv.indexOf(buildScriptFlag);
const requestedBuildScript =
  buildScriptFlagIndex === -1 ? undefined : process.argv[buildScriptFlagIndex + 1];
const buildScript = requestedBuildScript?.trim() || "build:extension";
const profileFlagIndex = process.argv.indexOf(profileFlag);
const requestedProfile =
  profileFlagIndex === -1 ? undefined : process.argv[profileFlagIndex + 1]?.trim();
const installAllProfiles = process.argv.includes(allProfilesFlag);

if (!validModes.has(mode)) {
  fail(
    `Usage: node ./scripts/vsix.mjs <package|install> [${profileBuildFlag}] [${buildScriptFlag} <script>] [${profileFlag} <name> | ${allProfilesFlag}]`,
  );
}

if (buildScriptFlagIndex !== -1 && !requestedBuildScript) {
  fail(`Missing value for ${buildScriptFlag}.`);
}

if (profileFlagIndex !== -1 && (!requestedProfile || requestedProfile.startsWith("--"))) {
  fail(`Missing value for ${profileFlag}.`);
}

if (installAllProfiles && mode !== "install") {
  fail(`${allProfilesFlag} is only valid for install mode.`);
}

if (installAllProfiles && requestedProfile) {
  fail(`${profileFlag} and ${allProfilesFlag} cannot be used together.`);
}

const packageJson = await import(new URL("../package.json", import.meta.url), {
  with: { type: "json" },
});
const extensionName = packageJson.default.name;
const extensionVersion = packageJson.default.version;
const extensionPublisher = packageJson.default.publisher;
const localAudioRoot = join(repoRoot, "local-audio");
const localAudioPackageJson = await import(
  new URL("../local-audio/package.json", import.meta.url),
  {
    with: { type: "json" },
  }
);
const localAudioTarget = `${process.platform}-${process.arch}`;
const installerDir = join(repoRoot, "installer");
const pnpmCli = resolveCommand("pnpm");
const vsceCli = findPackageBinaryPath("@vscode+vsce@", ["node_modules", "@vscode", "vsce", "vsce"]);
const vscodeCli = mode === "install" ? resolveCodeCli() : undefined;

if (!existsSync(installerDir)) {
  mkdirSync(installerDir, { recursive: true });
}

const vsixPath = resolveVsixPath(installerDir, extensionName, extensionVersion, mode);
const localAudioVsixPath = resolveVsixPath(
  installerDir,
  `${localAudioPackageJson.default.name}-${localAudioTarget}`,
  localAudioPackageJson.default.version,
  mode,
);

if (!pnpmCli) {
  fail("Could not find pnpm. Install pnpm and retry.");
}

if (!vsceCli) {
  fail("Could not find the local @vscode/vsce CLI. Run pnpm install and retry.");
}

if (mode === "install" && !vscodeCli) {
  fail(
    "Could not find an editor CLI. Install the 'code' or 'cursor' command, or set VSMUX_CODE_CLI to the editor binary path.",
  );
}

const targetProfiles = installAllProfiles
  ? resolveAllProfiles(vscodeCli ?? "code")
  : [requestedProfile];

if (installAllProfiles) {
  ensureEditorIsClosed(vscodeCli);
  console.log(
    `[vsix] Installing into profiles: ${targetProfiles.map((profile) => profile ?? "Default").join(", ")}.`,
  );
}

try {
  run(pnpmCli, ["run", buildScript], {
    env: {
      ...process.env,
      ...(profileBuild ? { VSMUX_PROFILE_BUILD: "1" } : {}),
    },
  });

  /**
   * CDXC:Agent-notifications 2026-08-02-12:11
   * The local UI companion owns native playback, so install it before the
   * workspace extension that declares it as a remote command dependency.
   */
  run(
    process.execPath,
    [
      vsceCli,
      "package",
      "--no-dependencies",
      "--skip-license",
      "--allow-unused-files-pattern",
      "--target",
      localAudioTarget,
      "--out",
      localAudioVsixPath,
    ],
    {
      cwd: localAudioRoot,
    },
  );

  run(
    process.execPath,
    [
      vsceCli,
      "package",
      "--no-dependencies",
      "--skip-license",
      "--allow-unused-files-pattern",
      "--out",
      vsixPath,
    ],
    {
      env: {
        ...process.env,
        VSMUX_SKIP_PREPUBLISH: "1",
      },
    },
  );

  if (mode === "package") {
    process.exit(0);
  }

  /**
   * CDXC:DevInstallation 2026-08-03-08:07 Editor profiles register extensions
   * independently, so every target profile must receive both the local audio
   * companion and the workspace extension.
   */
  if (installAllProfiles) {
    ensureEditorIsClosed(vscodeCli);
  }
  for (const targetProfile of targetProfiles) {
    const profileArgs = targetProfile ? [profileFlag, targetProfile] : [];
    run(vscodeCli, ["--install-extension", localAudioVsixPath, "--force", ...profileArgs]);
    run(vscodeCli, ["--install-extension", vsixPath, "--force", ...profileArgs]);
  }
} finally {
  if (mode === "install") {
    rmSync(localAudioVsixPath, { force: true });
    rmSync(vsixPath, { force: true });
  }
}
