import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { getVisibleTerminalTitle } from "../shared/session-grid-contract";
import type { TerminalAgentStatus } from "../shared/terminal-host-protocol";

export type PersistedSessionState = {
  agentName?: string;
  agentStatus: TerminalAgentStatus;
  agentSessionId?: string;
  /**
   * CDXC:Terminal-cwd 2026-07-29-21:45
   * Shell integrations report the live directory and prompt state. Consumers
   * must use only this explicit report, never infer CWD from a process.
   */
  cwd?: string;
  frozenAt?: string;
  hasAutoTitleFromFirstPrompt?: boolean;
  historyBase64?: string;
  isShellPromptIdle?: boolean;
  lastActivityAt?: string;
  pendingFirstPromptAutoRenamePrompt?: string;
  title?: string;
};

export type PersistedSessionStateSnapshot = {
  state: PersistedSessionState;
  updatedAtMs?: number;
};

const DEFAULT_PERSISTED_SESSION_STATE: PersistedSessionState = {
  agentName: undefined,
  agentStatus: "idle",
  agentSessionId: undefined,
  cwd: undefined,
  frozenAt: undefined,
  hasAutoTitleFromFirstPrompt: undefined,
  historyBase64: undefined,
  isShellPromptIdle: undefined,
  lastActivityAt: undefined,
  pendingFirstPromptAutoRenamePrompt: undefined,
  title: undefined,
};
const PERSISTED_SESSION_HOOK_DEDUP_MARKER_INFIX = ".hook-dedupe.";

export type PersistedSessionHookDedupMarkerResult = {
  acquired: boolean;
  markerPath: string;
};

export function createDefaultPersistedSessionState(): PersistedSessionState {
  return {
    ...DEFAULT_PERSISTED_SESSION_STATE,
  };
}

export function parsePersistedSessionState(rawState: string): PersistedSessionState {
  let agentName: string | undefined;
  let agentStatus: TerminalAgentStatus = "idle";
  let agentSessionId: string | undefined;
  let cwd: string | undefined;
  let frozenAt: string | undefined;
  let hasAutoTitleFromFirstPrompt: boolean | undefined;
  let historyBase64: string | undefined;
  let isShellPromptIdle: boolean | undefined;
  let lastActivityAt: string | undefined;
  let pendingFirstPromptAutoRenamePrompt: string | undefined;
  let title: string | undefined;

  for (const line of rawState.split(/\r?\n/)) {
    const [key, ...valueParts] = line.split("=");
    const rawValue = valueParts.join("=");
    const value = rawValue.trim();
    if (key === "agent") {
      agentName = value || undefined;
    }
    if (key === "agentSessionId") {
      agentSessionId = normalizePersistedSessionValue(value);
    }
    if (key === "cwd") {
      cwd = normalizePersistedWorkingDirectory(rawValue);
    }
    if (key === "title") {
      title = getVisibleTerminalTitle(value);
    }
    if (key === "historyBase64") {
      historyBase64 = normalizePersistedHistoryBase64(value);
    }
    if (key === "frozenAt") {
      frozenAt = normalizePersistedTimestamp(value);
    }
    if (key === "lastActivityAt") {
      lastActivityAt = normalizePersistedTimestamp(value);
    }
    if (key === "pendingFirstPromptAutoRenamePrompt") {
      pendingFirstPromptAutoRenamePrompt = normalizePersistedSessionValue(value);
    }
    if (key === "autoTitleFromFirstPrompt") {
      hasAutoTitleFromFirstPrompt = value === "1" || /^true$/i.test(value) ? true : undefined;
    }
    if (key === "status" && (value === "idle" || value === "working" || value === "attention")) {
      agentStatus = value;
    }
    if (key === "shellPromptIdle") {
      isShellPromptIdle =
        value === "1" || /^true$/i.test(value)
          ? true
          : value === "0" || /^false$/i.test(value)
            ? false
            : undefined;
    }
  }

  return {
    agentName,
    agentStatus,
    agentSessionId,
    ...(cwd ? { cwd } : {}),
    frozenAt,
    hasAutoTitleFromFirstPrompt,
    historyBase64,
    ...(isShellPromptIdle === undefined ? {} : { isShellPromptIdle }),
    lastActivityAt,
    pendingFirstPromptAutoRenamePrompt,
    title,
  };
}

export function serializePersistedSessionState(state: PersistedSessionState): string {
  return [
    `status=${state.agentStatus}`,
    `agent=${normalizePersistedSessionValue(state.agentName) ?? ""}`,
    `agentSessionId=${normalizePersistedSessionValue(state.agentSessionId) ?? ""}`,
    `cwd=${normalizePersistedWorkingDirectory(state.cwd) ?? ""}`,
    `frozenAt=${normalizePersistedTimestamp(state.frozenAt) ?? ""}`,
    `autoTitleFromFirstPrompt=${state.hasAutoTitleFromFirstPrompt ? "1" : ""}`,
    `historyBase64=${normalizePersistedHistoryBase64(state.historyBase64) ?? ""}`,
    `shellPromptIdle=${state.isShellPromptIdle === undefined ? "" : state.isShellPromptIdle ? "1" : "0"}`,
    `lastActivityAt=${normalizePersistedTimestamp(state.lastActivityAt) ?? ""}`,
    `pendingFirstPromptAutoRenamePrompt=${normalizePersistedSessionValue(state.pendingFirstPromptAutoRenamePrompt) ?? ""}`,
    `title=${normalizePersistedSessionValue(getVisibleTerminalTitle(state.title)) ?? ""}`,
    "",
  ].join("\n");
}

export function haveSamePersistedSessionState(
  left: PersistedSessionState,
  right: PersistedSessionState,
): boolean {
  return (
    left.agentName === right.agentName &&
    left.agentStatus === right.agentStatus &&
    left.agentSessionId === right.agentSessionId &&
    left.cwd === right.cwd &&
    left.frozenAt === right.frozenAt &&
    left.hasAutoTitleFromFirstPrompt === right.hasAutoTitleFromFirstPrompt &&
    left.historyBase64 === right.historyBase64 &&
    left.isShellPromptIdle === right.isShellPromptIdle &&
    left.lastActivityAt === right.lastActivityAt &&
    left.pendingFirstPromptAutoRenamePrompt === right.pendingFirstPromptAutoRenamePrompt &&
    left.title === right.title
  );
}

export function getPersistedShellStateFilePath(sessionStateFilePath: string): string {
  return `${sessionStateFilePath}.shell`;
}

/**
 * CDXC:Terminal-cwd 2026-07-29-23:07
 * Restarted terminals retain their session metadata but must discard the prior
 * shell's CWD and prompt state before a new shell is created.
 */
export async function deletePersistedShellStateFile(sessionStateFilePath: string): Promise<void> {
  await rm(getPersistedShellStateFilePath(sessionStateFilePath), { force: true });
}

export function mergePersistedShellState(
  sessionState: PersistedSessionState,
  shellState: PersistedSessionState,
): PersistedSessionState {
  /**
   * CDXC:Terminal-cwd 2026-07-29-22:14
   * Shell state is isolated from agent-hook writes, so the sidecar is the only
   * authority for live CWD and prompt-idle state.
   */
  return {
    ...sessionState,
    cwd: shellState.cwd,
    isShellPromptIdle: shellState.isShellPromptIdle,
  };
}

export async function readPersistedSessionStateFromFile(
  filePath: string,
): Promise<PersistedSessionState> {
  return (await readPersistedSessionStateSnapshotFromFile(filePath)).state;
}

export async function readPersistedSessionStateSnapshotFromFile(
  filePath: string,
): Promise<PersistedSessionStateSnapshot> {
  try {
    const [rawState, fileStat] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    return {
      state: parsePersistedSessionState(rawState),
      updatedAtMs: Number.isFinite(fileStat.mtimeMs) ? fileStat.mtimeMs : undefined,
    };
  } catch {
    return {
      state: createDefaultPersistedSessionState(),
      updatedAtMs: undefined,
    };
  }
}

export async function writePersistedSessionStateToFile(
  filePath: string,
  state: PersistedSessionState,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const tempFilePath = `${filePath}.tmp.${process.pid}`;
  await writeFile(tempFilePath, serializePersistedSessionState(state), "utf8");
  await rename(tempFilePath, filePath);
}

export function getPersistedSessionHookDedupMarkerPath(
  filePath: string,
  eventName: string,
  fingerprint: string,
): string {
  const markerFileName = `${path.basename(filePath)}${PERSISTED_SESSION_HOOK_DEDUP_MARKER_INFIX}${sanitizePersistedSessionHookDedupPart(eventName)}.${sanitizePersistedSessionHookDedupPart(fingerprint)}`;
  return path.join(path.dirname(filePath), markerFileName);
}

export async function createPersistedSessionHookDedupMarker(
  filePath: string,
  eventName: string,
  fingerprint: string,
): Promise<PersistedSessionHookDedupMarkerResult> {
  const markerPath = getPersistedSessionHookDedupMarkerPath(filePath, eventName, fingerprint);
  await mkdir(path.dirname(markerPath), { recursive: true });

  try {
    await writeFile(markerPath, "", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (isExistingFileError(error)) {
      return {
        acquired: false,
        markerPath,
      };
    }

    throw error;
  }

  await cleanupPersistedSessionHookDedupMarkers(filePath, markerPath);
  return {
    acquired: true,
    markerPath,
  };
}

export async function updatePersistedSessionStateFile(
  filePath: string,
  updater: (state: PersistedSessionState) => PersistedSessionState,
): Promise<PersistedSessionState> {
  const currentState = await readPersistedSessionStateFromFile(filePath);
  const nextState = updater(currentState);
  if (haveSamePersistedSessionState(currentState, nextState)) {
    return currentState;
  }

  await writePersistedSessionStateToFile(filePath, nextState);
  return nextState;
}

export async function deletePersistedSessionStateFile(filePath: string): Promise<void> {
  await Promise.all([
    rm(filePath, { force: true }).catch(() => undefined),
    deletePersistedShellStateFile(filePath).catch(() => undefined),
  ]);
  await cleanupPersistedSessionHookDedupMarkers(filePath).catch(() => undefined);
}

function normalizePersistedSessionValue(value: string | undefined): string | undefined {
  const normalizedValue = value?.replace(/\s+/g, " ").trim();
  return normalizedValue && normalizedValue.length > 0 ? normalizedValue : undefined;
}

function normalizePersistedWorkingDirectory(value: string | undefined): string | undefined {
  return value && !/[\r\n\0]/.test(value) ? value : undefined;
}

function normalizePersistedHistoryBase64(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return undefined;
  }

  try {
    return Buffer.from(normalizedValue, "base64").toString("base64");
  } catch {
    return undefined;
  }
}

function normalizePersistedTimestamp(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return undefined;
  }

  const timestampMs = Date.parse(normalizedValue);
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : undefined;
}

async function cleanupPersistedSessionHookDedupMarkers(
  filePath: string,
  keepMarkerPath?: string,
): Promise<void> {
  const markerPrefix = `${path.basename(filePath)}${PERSISTED_SESSION_HOOK_DEDUP_MARKER_INFIX}`;
  const directoryPath = path.dirname(filePath);
  const markerFileNameToKeep = keepMarkerPath ? path.basename(keepMarkerPath) : undefined;
  const directoryEntries = await readdir(directoryPath).catch(() => []);

  await Promise.all(
    directoryEntries
      .filter((entry) => entry.startsWith(markerPrefix) && entry !== markerFileNameToKeep)
      .map((entry) => rm(path.join(directoryPath, entry), { force: true }).catch(() => undefined)),
  );
}

function sanitizePersistedSessionHookDedupPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
}

const isExistingFileError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "EEXIST";
