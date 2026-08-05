import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { appendAgentShellDebugLog } from "./agent-shell-debug-log";
import { detectCodexLifecycleEventFromLogLine } from "./agent-shell-integration";
import { ensureClaudeHooksFile } from "./claude-hooks-config";
import { ensureCodexHooksFile } from "./codex-hooks-config";
import {
  updatePersistedSessionStateFile,
  writePersistedSessionStateToFile,
} from "./session-state-file";

type AgentName = "claude" | "codex" | "gemini" | "opencode";

type WrapperRunnerOptions = {
  agent: AgentName;
  binDir: string;
  claudeSettingsPath: string;
  debugLogPath: string;
  forwardedArgs: string[];
  notifyRunnerPath: string;
  opencodeConfigDir: string;
};

type CodexWatcherHandle = {
  stop: () => void;
};

type OpenCodeStateOwner = {
  pid: number;
};

type OpenCodeStateOwnerHandle = {
  ownerFilePath: string;
  pid: number;
};

type AgentProcessLifecycle = {
  processGroupId: number | undefined;
  stateOwner: OpenCodeStateOwnerHandle | undefined;
};

export type UnixProcessSnapshot = {
  command: string;
  pgid: number;
  pid: number;
  ppid: number;
};

const CODEX_LOG_POLL_INTERVAL_MS = 200;
const OPEN_CODE_OWNER_FILE_SUFFIX = ".opencode-owner";
const PROCESS_TREE_TERMINATION_TIMEOUT_MS = 4_000;
const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  process.env.VSMUX_AGENT_SHELL_DEBUG_LOG_PATH = options.debugLogPath;
  const args = normalizeOpenCodeArguments(options.agent, options.forwardedArgs);
  const stateFilePath = process.env.VSMUX_SESSION_STATE_FILE?.trim();
  const isInteractiveOpenCode =
    options.agent === "opencode" && isInteractiveOpenCodeInvocation(args);
  const executablePath = resolveExecutablePath(options.agent, options.binDir);
  if (!executablePath) {
    throw new Error(`VSmux: ${options.agent} not found in PATH.`);
  }

  const processGroupId = isInteractiveOpenCode
    ? await getUnixProcessGroupId(process.pid)
    : undefined;
  if (stateFilePath && isInteractiveOpenCode && process.platform !== "win32" && !processGroupId) {
    await appendAgentShellDebugLog("wrapper.launch.skippedMissingProcessGroup", {
      agent: options.agent,
      sessionStateFilePath: stateFilePath,
    });
    return;
  }
  const stateOwner =
    stateFilePath && isInteractiveOpenCode
      ? await acquireOpenCodeStateOwner(stateFilePath)
      : undefined;
  if (stateFilePath && isInteractiveOpenCode && !stateOwner) {
    await appendAgentShellDebugLog("wrapper.launch.skippedExistingOpenCode", {
      agent: options.agent,
      sessionStateFilePath: stateFilePath,
    });
    return;
  }

  const environment = createAgentEnvironment(options.agent, process.env);
  await appendAgentShellDebugLog("wrapper.launch.prepare", {
    agent: options.agent,
    executablePath,
    forwardedArgs: args,
  });

  switch (options.agent) {
    case "claude":
      delete environment.ELECTRON_RUN_AS_NODE;
      await writeInitialSessionState("claude", "Claude Code");
      try {
        const hooksResult = await ensureClaudeHooksFile(
          resolveClaudeNotifyCommandPath(options.claudeSettingsPath),
          environment,
        );
        await appendAgentShellDebugLog("wrapper.claude.hooksReady", {
          changed: hooksResult.changed,
          settingsPath: hooksResult.settingsPath,
        });
      } catch (error) {
        await appendAgentShellDebugLog("wrapper.claude.hooksFailed", serializeUnknownError(error));
      }
      args.unshift("--settings", options.claudeSettingsPath);
      break;
    case "codex": {
      delete environment.ELECTRON_RUN_AS_NODE;
      await writeInitialSessionState("codex", "Codex");
      environment.CODEX_TUI_RECORD_SESSION = "1";
      environment.VSMUX_AGENT_SHELL_DEBUG_LOG_PATH = options.debugLogPath;
      if (!environment.CODEX_TUI_SESSION_LOG_PATH) {
        environment.CODEX_TUI_SESSION_LOG_PATH = path.join(
          os.tmpdir(),
          `VSmux-codex-${process.pid}-${Date.now()}.jsonl`,
        );
      }
      args.unshift("-c", "features.codex_hooks=true");
      args.unshift("-c", `notify=${JSON.stringify([process.execPath, options.notifyRunnerPath])}`);
      try {
        const hooksResult = await ensureCodexHooksFile(options.notifyRunnerPath, environment);
        await appendAgentShellDebugLog("wrapper.codex.hooksReady", {
          changed: hooksResult.changed,
          hooksPath: hooksResult.hooksPath,
        });
      } catch (error) {
        await appendAgentShellDebugLog("wrapper.codex.hooksFailed", serializeUnknownError(error));
      }
      break;
    }
    case "gemini":
      delete environment.ELECTRON_RUN_AS_NODE;
      await writeInitialSessionState("gemini", "Gemini");
      break;
    case "opencode":
      delete environment.ELECTRON_RUN_AS_NODE;
      if (isInteractiveOpenCode) {
        await writeInitialSessionState("opencode", "OpenCode");
      }
      environment.OPENCODE_CONFIG_DIR = options.opencodeConfigDir;
      break;
  }

  const watcher =
    options.agent === "codex" && environment.CODEX_TUI_SESSION_LOG_PATH
      ? startCodexWatcher(
          environment.CODEX_TUI_SESSION_LOG_PATH,
          options.notifyRunnerPath,
          environment.VSMUX_SESSION_STATE_FILE,
        )
      : undefined;

  await appendAgentShellDebugLog("wrapper.launch.spawn", {
    agent: options.agent,
    args,
    codexHome: environment.CODEX_HOME,
    detached: shouldSpawnAgentInDetachedGroup(),
    notifyRunnerPath: options.notifyRunnerPath,
    sessionLogPath: environment.CODEX_TUI_SESSION_LOG_PATH,
    sessionStateFilePath: stateFilePath,
    wrapperTty: readWrapperTtySnapshot(),
  });
  const exitCode = await spawnAgentProcess(options.agent, executablePath, args, environment, {
    processGroupId,
    stateOwner,
  });
  await appendAgentShellDebugLog("wrapper.launch.exit", {
    agent: options.agent,
    exitCode,
  });
  watcher?.stop();
  process.exit(exitCode);
}

export function createAgentEnvironment(
  agent: AgentName,
  baseEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  /**
   * CDXC:Claude-session-status 2026-04-25-08:10
   * Claude Code terminal-title OSC updates must stay enabled. VSmux uses those
   * title transitions to derive Claude sidebar names and working/done indicators.
   */
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    VSMUX_AGENT: agent,
    VSMUX_WRAPPER_PID: String(process.pid),
  };

  return environment;
}

function parseArgs(argv: readonly string[]): WrapperRunnerOptions {
  const separatorIndex = argv.indexOf("--");
  const optionArgs = separatorIndex >= 0 ? argv.slice(0, separatorIndex) : argv;
  const forwardedArgs = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];
  const values = new Map<string, string>();

  for (let index = 0; index < optionArgs.length; index += 2) {
    const key = optionArgs[index];
    const value = optionArgs[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid wrapper argument list: ${argv.join(" ")}`);
    }

    values.set(key.slice(2), value);
  }

  const agent = getRequiredArg(values, "agent");
  if (agent !== "claude" && agent !== "codex" && agent !== "gemini" && agent !== "opencode") {
    throw new Error(`Unsupported agent: ${agent}`);
  }

  return {
    agent,
    binDir: getRequiredArg(values, "bin-dir"),
    claudeSettingsPath: getRequiredArg(values, "claude-settings-path"),
    debugLogPath: getRequiredArg(values, "debug-log-path"),
    forwardedArgs,
    notifyRunnerPath: getRequiredArg(values, "notify-runner-path"),
    opencodeConfigDir: getRequiredArg(values, "opencode-config-dir"),
  };
}

function getRequiredArg(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) {
    throw new Error(`Missing required argument: --${key}`);
  }

  return value;
}

function resolveExecutablePath(agent: AgentName, binDir: string): string | undefined {
  const currentPath = process.env.PATH ?? "";
  const pathEntries = currentPath.split(path.delimiter);
  const normalizedBinDir = normalizePath(binDir);
  const candidateNames = getCandidateExecutableNames(agent);

  for (const pathEntry of pathEntries) {
    if (!pathEntry) {
      continue;
    }

    if (normalizePath(pathEntry) === normalizedBinDir) {
      continue;
    }

    for (const candidateName of candidateNames) {
      const candidatePath = path.join(pathEntry, candidateName);
      try {
        const fileStats = statSync(candidatePath);
        if (fileStats.isFile()) {
          return candidatePath;
        }
      } catch {
        continue;
      }
    }
  }

  return undefined;
}

function normalizePath(value: string): string {
  const resolvedValue = path.resolve(value);
  return process.platform === "win32" ? resolvedValue.toLowerCase() : resolvedValue;
}

export function getCandidateExecutableNames(
  agent: AgentName,
  platform = process.platform,
  pathExt = process.env.PATHEXT,
): string[] {
  if (platform !== "win32") {
    return [agent];
  }

  const pathExtensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((entry) => entry.length > 0);

  const pathextCandidates = pathExtensions.map((extension) => `${agent}${extension.toLowerCase()}`);
  return agent === "codex" ? pathextCandidates : [...pathextCandidates, agent];
}

/**
 * CDXC:OpenCode-lifecycle 2026-08-04-15:33
 * A failed title lookup starts a fresh OpenCode session. Do not forward `-s ""`,
 * because OpenCode treats it as another interactive root for the same terminal.
 */
export function normalizeOpenCodeArguments(agent: AgentName, args: readonly string[]): string[] {
  if (agent !== "opencode") {
    return [...args];
  }

  const sessionFlagIndex = args.findIndex((arg) => arg === "-s" || arg === "--session");
  if (sessionFlagIndex < 0 || args[sessionFlagIndex + 1]?.trim()) {
    return [...args];
  }

  return [...args.slice(0, sessionFlagIndex), ...args.slice(sessionFlagIndex + 2)];
}

export function isInteractiveOpenCodeInvocation(args: readonly string[]): boolean {
  return args.length === 0 || args[0] === "-s" || args[0] === "--session";
}

async function writeInitialSessionState(agent: AgentName, title: string): Promise<void> {
  const stateFilePath = process.env.VSMUX_SESSION_STATE_FILE?.trim();
  if (!stateFilePath) {
    return;
  }

  await writePersistedSessionStateToFile(stateFilePath, {
    agentName: agent,
    agentStatus: "idle",
    lastActivityAt: new Date().toISOString(),
    title,
  }).catch(() => undefined);
}

function resolveClaudeNotifyCommandPath(claudeSettingsPath: string): string {
  return path.join(
    path.dirname(claudeSettingsPath),
    process.platform === "win32" ? "notify.cmd" : "notify.sh",
  );
}

function startCodexWatcher(
  logFilePath: string,
  notifyRunnerPath: string,
  sessionStateFilePath: string | undefined,
): CodexWatcherHandle {
  let disposed = false;
  let pendingLine = "";
  let lastContentLength = 0;
  let lastSeenSessionId: string | undefined;
  const lastEventTurnIdByType = new Map<string, string>();
  let polling = false;

  const timer = setInterval(() => {
    if (disposed || polling) {
      return;
    }

    polling = true;
    void readFile(logFilePath, "utf8")
      .then((content) => {
        if (disposed) {
          return;
        }

        if (content.length < lastContentLength) {
          lastContentLength = 0;
          pendingLine = "";
        }

        if (content.length === lastContentLength) {
          return;
        }

        const nextChunk = `${pendingLine}${content.slice(lastContentLength)}`;
        lastContentLength = content.length;
        const lines = nextChunk.split(/\r?\n/);
        pendingLine = lines.pop() ?? "";

        for (const line of lines) {
          const sessionId = extractCodexSessionId(line);
          if (sessionId && sessionId !== lastSeenSessionId) {
            lastSeenSessionId = sessionId;
            void persistCodexSessionId(sessionStateFilePath, sessionId);
          }

          const eventType = detectCodexLifecycleEventFromLogLine(line);
          if (!eventType) {
            continue;
          }

          const turnId = extractTurnId(line);
          if (turnId && turnId === lastEventTurnIdByType.get(eventType)) {
            continue;
          }

          if (turnId) {
            lastEventTurnIdByType.set(eventType, turnId);
          }

          void appendAgentShellDebugLog("wrapper.codex.watcherEvent", {
            eventType,
            logFilePath,
            source: "session-log",
            turnId,
          });
          emitNotifyEvent(
            eventType === "waiting" ? "Wait" : eventType === "stop" ? "Stop" : "Start",
            notifyRunnerPath,
          );
        }
      })
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }, CODEX_LOG_POLL_INTERVAL_MS);

  timer.unref?.();

  return {
    stop: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}

function extractTurnId(line: string): string | undefined {
  return line.match(/"turn_id":"([^"]+)"/)?.[1];
}

export function extractCodexSessionId(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as {
      payload?: { id?: unknown };
      type?: unknown;
    };
    return parsed.type === "session_meta" && typeof parsed.payload?.id === "string"
      ? parsed.payload.id
      : undefined;
  } catch {
    return undefined;
  }
}

async function persistCodexSessionId(
  stateFilePath: string | undefined,
  sessionId: string,
): Promise<void> {
  const normalizedStateFilePath = stateFilePath?.trim();
  if (!normalizedStateFilePath) {
    return;
  }

  await updatePersistedSessionStateFile(normalizedStateFilePath, (state) => ({
    ...state,
    agentSessionId: sessionId,
  })).catch(() => undefined);
}

function emitNotifyEvent(eventName: "Start" | "Stop" | "Wait", notifyRunnerPath: string): void {
  void appendAgentShellDebugLog("wrapper.notify.emit", {
    eventName,
    notifyRunnerPath,
  });
  const payload = JSON.stringify({
    agent: "codex",
    hook_event_name: eventName,
  });

  const child = spawn(process.execPath, [notifyRunnerPath, payload], {
    detached: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      VSMUX_AGENT: "codex",
    },
    stdio: "ignore",
  });
  child.unref();
}

export function shouldSpawnAgentInDetachedGroup(platform = process.platform): boolean {
  void platform;
  /**
   * CDXC:AgentTerminalResize 2026-04-29-08:19
   * Interactive agent CLIs must stay in the terminal's foreground process
   * group. Detaching the child creates a new session on Unix, which leaves
   * Claude Code without the controlling TTY it uses through Ink/Node to receive
   * SIGWINCH and recompute terminal columns during embedded terminal resizes.
   */
  return false;
}

export function getProcessTreeKillTarget(pid: number, platform = process.platform): number {
  return shouldSpawnAgentInDetachedGroup(platform) ? -Math.abs(pid) : Math.abs(pid);
}

function spawnAgentProcess(
  agent: AgentName,
  executablePath: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  lifecycle: AgentProcessLifecycle,
): Promise<number> {
  if (process.platform === "win32" && agent === "codex") {
    const executableDir = path.dirname(executablePath);
    const nodePath = path.join(executableDir, "node.exe");
    const codexEntrypointPath = path.join(
      executableDir,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );

    try {
      if (statSync(nodePath).isFile() && statSync(codexEntrypointPath).isFile()) {
        return waitForAgentProcessExit(
          agent,
          spawn(nodePath, [codexEntrypointPath, ...args], {
            detached: shouldSpawnAgentInDetachedGroup(),
            env: environment,
            stdio: "inherit",
          }),
          lifecycle,
        );
      }
    } catch {
      // Fall back to the resolved executable path if this is not an npm-style global Codex install.
    }
  }

  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(executablePath)) {
    return new Promise((resolve, reject) => {
      const commandLine = [`"${executablePath}"`, ...args.map(quoteWindowsCommandArgument)].join(
        " ",
      );
      void waitForAgentProcessExit(
        agent,
        spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", commandLine], {
          detached: shouldSpawnAgentInDetachedGroup(),
          env: environment,
          stdio: "inherit",
          windowsVerbatimArguments: true,
        }),
        lifecycle,
      ).then(resolve, reject);
    });
  }

  return waitForAgentProcessExit(
    agent,
    spawn(executablePath, [...args], {
      detached: shouldSpawnAgentInDetachedGroup(),
      env: environment,
      stdio: "inherit",
    }),
    lifecycle,
  );
}

function waitForAgentProcessExit(
  agent: AgentName,
  child: ReturnType<typeof spawn>,
  lifecycle: AgentProcessLifecycle,
): Promise<number> {
  const cleanup = registerWrapperTerminationHandlers(agent, child, lifecycle);
  void appendAgentShellDebugLog("wrapper.launch.spawned", {
    agent,
    childPid: child.pid,
    detached: shouldSpawnAgentInDetachedGroup(),
    wrapperTty: readWrapperTtySnapshot(),
  });

  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      cleanup();
      void releaseOpenCodeStateOwner(lifecycle.stateOwner).finally(() => reject(error));
    });
    child.once("exit", (code) => {
      cleanup();
      void releaseOpenCodeStateOwner(lifecycle.stateOwner).finally(() => resolve(code ?? 1));
    });
  });
}

function registerWrapperTerminationHandlers(
  agent: AgentName,
  child: ReturnType<typeof spawn>,
  lifecycle: AgentProcessLifecycle,
): () => void {
  let forcedKillTimer: NodeJS.Timeout | undefined;
  let isCleaningUp = false;

  const terminateChildTree = (signal: NodeJS.Signals, source: string): void => {
    if (isCleaningUp) {
      return;
    }
    isCleaningUp = true;
    void appendAgentShellDebugLog("wrapper.launch.terminateChildTree", {
      agent,
      childPid: child.pid,
      signal,
      source,
    });
    const isGroupTerminatorScheduled = terminateChildProcessTree(
      child.pid,
      lifecycle.processGroupId,
      lifecycle.stateOwner,
      signal,
    );
    if (!isGroupTerminatorScheduled) {
      forcedKillTimer = setTimeout(() => {
        terminateChildProcessTree(child.pid, undefined, undefined, "SIGKILL");
      }, PROCESS_TREE_TERMINATION_TIMEOUT_MS);
      forcedKillTimer.unref?.();
    }
  };

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      if (signal === "SIGINT") {
        /**
         * CDXC:AgentTerminalResize 2026-04-29-08:19
         * Attached agent children share the foreground terminal process group
         * so they receive Ctrl-C directly. The wrapper must not convert that
         * user interrupt into a process-tree kill because Claude/Codex use
         * SIGINT for in-app cancellation.
         */
        void appendAgentShellDebugLog("wrapper.launch.agentOwnedSignal", {
          agent,
          childPid: child.pid,
          signal,
        });
        return;
      }

      terminateChildTree(signal, "wrapper-signal");
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  const exitHandler = () => {
    terminateChildTree("SIGTERM", "wrapper-exit");
  };
  process.once("exit", exitHandler);

  return () => {
    if (forcedKillTimer) {
      clearTimeout(forcedKillTimer);
      forcedKillTimer = undefined;
    }
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    process.removeListener("exit", exitHandler);
  };
}

function readWrapperTtySnapshot(): Record<string, unknown> {
  return {
    columns: process.stdout.isTTY ? process.stdout.columns : undefined,
    pid: process.pid,
    platform: process.platform,
    ppid: process.ppid,
    rows: process.stdout.isTTY ? process.stdout.rows : undefined,
    stderrIsTTY: process.stderr.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  };
}

function terminateChildProcessTree(
  pid: number | undefined,
  processGroupId: number | undefined,
  stateOwner: OpenCodeStateOwnerHandle | undefined,
  signal: NodeJS.Signals,
): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  /**
   * CDXC:OpenCode-lifecycle 2026-08-04-15:33
   * OpenCode and its MCP servers share the foreground terminal group. A detached
   * reaper survives the wrapper's shutdown long enough to terminate that whole
   * group and escalate to SIGKILL when an MCP child ignores SIGTERM.
   */
  if (process.platform !== "win32" && stateOwner && processGroupId && processGroupId > 0) {
    const reaper = spawn(
      process.execPath,
      [
        __filename,
        "--terminate-process-group",
        String(processGroupId),
        stateOwner?.ownerFilePath ?? "",
        String(stateOwner?.pid ?? ""),
      ],
      {
        detached: true,
        env: process.env,
        stdio: "ignore",
      },
    );
    reaper.unref();
    return true;
  }

  try {
    process.kill(getProcessTreeKillTarget(pid), signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Ignore races where the child already exited.
    }
  }
  return false;
}

/**
 * CDXC:OpenCode-lifecycle 2026-08-04-15:33
 * An interactive VSmux terminal owns one OpenCode process group per persisted
 * state file. Only orphaned groups are replaced; a still-attached terminal
 * keeps its running session and is never relaunched.
 */
async function acquireOpenCodeStateOwner(
  stateFilePath: string,
): Promise<OpenCodeStateOwnerHandle | undefined> {
  const ownerFilePath = `${stateFilePath}${OPEN_CODE_OWNER_FILE_SUFFIX}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = await readOpenCodeStateOwner(ownerFilePath);
    const processes = await listOpenCodeStateFileProcesses(stateFilePath);
    if (!processes) {
      return undefined;
    }
    const ownerProcess = owner
      ? processes.find((processInfo) => processInfo.pid === owner.pid)
      : undefined;
    if (owner && isProcessAlive(owner.pid) && (!ownerProcess || ownerProcess.ppid !== 1)) {
      return undefined;
    }

    const processGroupIds = selectOpenCodeStateFileProcessGroups(processes, stateFilePath);
    const orphanedProcessGroupIds = processGroupIds.filter((processGroupId) =>
      processes.some(
        (processInfo) => processInfo.pgid === processGroupId && processInfo.ppid === 1,
      ),
    );
    if (orphanedProcessGroupIds.length !== processGroupIds.length) {
      return undefined;
    }

    await terminateUnixProcessGroups(orphanedProcessGroupIds);
    await unlink(ownerFilePath).catch(() => undefined);

    try {
      const ownerHandle = await open(ownerFilePath, "wx");
      try {
        await ownerHandle.writeFile(
          JSON.stringify({
            pid: process.pid,
          } satisfies OpenCodeStateOwner),
        );
      } finally {
        await ownerHandle.close();
      }
      return {
        ownerFilePath,
        pid: process.pid,
      };
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
    }
  }

  return undefined;
}

async function releaseOpenCodeStateOwner(
  stateOwner: OpenCodeStateOwnerHandle | undefined,
): Promise<void> {
  if (!stateOwner) {
    return;
  }

  const owner = await readOpenCodeStateOwner(stateOwner.ownerFilePath);
  if (owner?.pid !== stateOwner.pid) {
    return;
  }

  await unlink(stateOwner.ownerFilePath).catch(() => undefined);
}

async function readOpenCodeStateOwner(
  ownerFilePath: string,
): Promise<OpenCodeStateOwner | undefined> {
  try {
    const rawOwner = await readFile(ownerFilePath, "utf8");
    const parsedOwner = JSON.parse(rawOwner) as Partial<OpenCodeStateOwner>;
    if (typeof parsedOwner.pid !== "number" || parsedOwner.pid <= 0) {
      return undefined;
    }

    return {
      pid: parsedOwner.pid,
    };
  } catch {
    return undefined;
  }
}

async function listOpenCodeStateFileProcesses(
  stateFilePath: string,
): Promise<UnixProcessSnapshot[] | undefined> {
  if (process.platform === "win32") {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("ps", ["eww", "-axo", "pid=,ppid=,pgid=,command="], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseUnixProcessList(stdout).filter(
      (processInfo) =>
        processInfo.pid !== process.pid &&
        isInteractiveOpenCodeStateFileProcess(processInfo.command, stateFilePath),
    );
  } catch {
    return undefined;
  }
}

export function parseUnixProcessList(rawOutput: string): UnixProcessSnapshot[] {
  return rawOutput.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\s\S]+)$/);
    if (!match) {
      return [];
    }

    return [
      {
        command: match[4],
        pgid: Number.parseInt(match[3], 10),
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
      },
    ];
  });
}

export function selectOpenCodeStateFileProcessGroups(
  processes: readonly UnixProcessSnapshot[],
  stateFilePath: string,
): number[] {
  return [
    ...new Set(
      processes
        .filter((processInfo) =>
          isInteractiveOpenCodeStateFileProcess(processInfo.command, stateFilePath),
        )
        .map((processInfo) => processInfo.pgid),
    ),
  ];
}

function isInteractiveOpenCodeStateFileProcess(command: string, stateFilePath: string): boolean {
  const normalizedCommand = command.toLowerCase();
  if (
    !hasExactOpenCodeStateFileMarker(command, stateFilePath) ||
    isOpenCodeUtilityCommand(normalizedCommand)
  ) {
    return false;
  }

  return (
    (normalizedCommand.includes("agent-shell-wrapper-runner.js") &&
      normalizedCommand.includes("--agent opencode")) ||
    normalizedCommand.includes("vsmux_agent=opencode")
  );
}

function hasExactOpenCodeStateFileMarker(command: string, stateFilePath: string): boolean {
  const marker = `VSMUX_SESSION_STATE_FILE=${stateFilePath}`;
  const markerIndex = command.indexOf(marker);
  if (markerIndex < 0) {
    return false;
  }

  const markerEndIndex = markerIndex + marker.length;
  return markerEndIndex === command.length || /\s/.test(command[markerEndIndex] ?? "");
}

function isOpenCodeUtilityCommand(command: string): boolean {
  return (
    command.includes("session list") ||
    command.includes("opencode mcp") ||
    command.includes("opencode run") ||
    command.includes("opencode serve") ||
    command.includes("-- mcp") ||
    command.includes("-- run") ||
    command.includes("-- serve")
  );
}

async function getUnixProcessGroupId(pid: number): Promise<number | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)]);
    const processGroupId = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(processGroupId) && processGroupId > 0 ? processGroupId : undefined;
  } catch {
    return undefined;
  }
}

async function terminateUnixProcessGroups(processGroupIds: readonly number[]): Promise<void> {
  const uniqueProcessGroupIds = [
    ...new Set(processGroupIds.filter((processGroupId) => processGroupId > 0)),
  ];
  for (const processGroupId of uniqueProcessGroupIds) {
    signalUnixProcessGroup(processGroupId, "SIGTERM");
  }

  const deadline = Date.now() + PROCESS_TREE_TERMINATION_TIMEOUT_MS;
  while (
    uniqueProcessGroupIds.some((processGroupId) => isUnixProcessGroupAlive(processGroupId)) &&
    Date.now() < deadline
  ) {
    await delay(100);
  }

  for (const processGroupId of uniqueProcessGroupIds) {
    if (isUnixProcessGroupAlive(processGroupId)) {
      signalUnixProcessGroup(processGroupId, "SIGKILL");
    }
  }
}

async function terminateProcessGroupFromArgs(args: readonly string[]): Promise<void> {
  const processGroupId = Number.parseInt(args[1] ?? "", 10);
  const ownerFilePath = args[2];
  const ownerPid = Number.parseInt(args[3] ?? "", 10);
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
    process.exitCode = 1;
    return;
  }

  await terminateUnixProcessGroups([processGroupId]);
  if (ownerFilePath && Number.isInteger(ownerPid) && ownerPid > 0) {
    await releaseOpenCodeStateOwner({ ownerFilePath, pid: ownerPid });
  }
}

/**
 * CDXC:OpenCode-lifecycle 2026-08-04-17:01
 * Explicit terminal teardown must clean the exact persisted session's OpenCode
 * group even after the PTY has orphaned its wrapper. This command is invoked by
 * the terminal daemon; it never selects another session's state-file marker.
 */
async function terminateOpenCodeStateFileFromArgs(args: readonly string[]): Promise<void> {
  const stateFilePath = args[1]?.trim();
  if (!stateFilePath || process.platform === "win32") {
    return;
  }

  const processes = await listOpenCodeStateFileProcesses(stateFilePath);
  if (!processes) {
    throw new Error("VSmux: could not inspect OpenCode processes for terminal teardown.");
  }

  await terminateUnixProcessGroups(selectOpenCodeStateFileProcessGroups(processes, stateFilePath));
  await unlink(`${stateFilePath}${OPEN_CODE_OWNER_FILE_SUFFIX}`).catch(() => undefined);
}

function signalUnixProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // The group may have exited while cleanup was being scheduled.
  }
}

function isUnixProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function serializeUnknownError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    error: String(error),
  };
}

function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

const isMainModule =
  typeof __filename === "string" &&
  process.argv[1] !== undefined &&
  normalizePath(process.argv[1]) === normalizePath(__filename);

if (isMainModule) {
  const args = process.argv.slice(2);
  const entrypoint =
    args[0] === "--terminate-process-group"
      ? terminateProcessGroupFromArgs(args)
      : args[0] === "--terminate-opencode-state"
        ? terminateOpenCodeStateFileFromArgs(args)
        : main();
  void entrypoint.catch((error) => {
    void appendAgentShellDebugLog("wrapper.launch.failed", serializeUnknownError(error));
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
