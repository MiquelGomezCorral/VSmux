import type * as vscode from "vscode";
import { readManagedTerminalIdentityFromProcessId } from "./native-terminal-process-identity";

const SESSION_ID_ENV_KEY = "VSMUX_SESSION_ID";
const SHELL_STATE_FILE_ENV_KEY = "VSMUX_SHELL_STATE_FILE";
const SESSION_STATE_FILE_ENV_KEY = "VSMUX_SESSION_STATE_FILE";
const WORKSPACE_ID_ENV_KEY = "VSMUX_WORKSPACE_ID";
const WORKSPACE_ROOT_ENV_KEY = "VSMUX_WORKSPACE_ROOT";
const GROUP_ID_ENV_KEY = "VSMUX_GROUP_ID";

export type ManagedTerminalIdentity = {
  groupId?: string;
  sessionId: string;
  workspaceId: string;
};

export function createManagedTerminalEnvironment(
  workspaceId: string,
  sessionId: string,
  sessionStateFilePath: string,
  workspaceRoot?: string,
  groupId?: string,
): Record<string, string> {
  const normalizedWorkspaceRoot = normalizeEnvironmentValue(workspaceRoot);
  const normalizedGroupId = normalizeEnvironmentValue(groupId);
  return {
    [SESSION_ID_ENV_KEY]: sessionId,
    [SHELL_STATE_FILE_ENV_KEY]: `${sessionStateFilePath}.shell`,
    [SESSION_STATE_FILE_ENV_KEY]: sessionStateFilePath,
    [WORKSPACE_ID_ENV_KEY]: workspaceId,
    ...(normalizedGroupId ? { [GROUP_ID_ENV_KEY]: normalizedGroupId } : {}),
    ...(normalizedWorkspaceRoot ? { [WORKSPACE_ROOT_ENV_KEY]: normalizedWorkspaceRoot } : {}),
  };
}

export function getManagedTerminalIdentity(
  terminal: vscode.Terminal,
): ManagedTerminalIdentity | undefined {
  const creationOptions = terminal.creationOptions;
  if (!creationOptions || "pty" in creationOptions) {
    return undefined;
  }

  const environment = creationOptions.env;
  if (!environment) {
    return undefined;
  }

  const sessionId = normalizeEnvironmentValue(environment[SESSION_ID_ENV_KEY]);
  const workspaceId = normalizeEnvironmentValue(environment[WORKSPACE_ID_ENV_KEY]);
  const groupId = normalizeEnvironmentValue(environment[GROUP_ID_ENV_KEY]);
  if (!sessionId || !workspaceId) {
    return undefined;
  }

  return {
    ...(groupId ? { groupId } : {}),
    sessionId,
    workspaceId,
  };
}

/**
 * CDXC:TerminalMigration 2026-08-09-13:05
 * Switching back to the custom surface resolves creation or process identity
 * and removes every native terminal owned by this workspace, including stale
 * sessions. Unowned VS Code terminals remain untouched.
 */
export async function disposeManagedTerminalsForWorkspace(
  terminals: readonly vscode.Terminal[],
  workspaceId: string,
): Promise<boolean> {
  let didDisposeTerminal = false;
  for (const terminal of terminals) {
    const identity = await resolveManagedTerminalIdentity(terminal);
    if (identity?.workspaceId !== workspaceId) {
      continue;
    }

    terminal.dispose();
    didDisposeTerminal = true;
  }

  return didDisposeTerminal;
}

async function resolveManagedTerminalIdentity(
  terminal: vscode.Terminal,
): Promise<ManagedTerminalIdentity | undefined> {
  const creationOptions = terminal.creationOptions;
  if (!creationOptions || "pty" in creationOptions) {
    return undefined;
  }

  const creationIdentity = getManagedTerminalIdentity(terminal);
  if (creationIdentity) {
    return creationIdentity;
  }

  try {
    const processId = await terminal.processId;
    return typeof processId === "number"
      ? await readManagedTerminalIdentityFromProcessId(processId)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeEnvironmentValue(value: string | null | undefined): string | undefined {
  const normalizedValue = value?.trim();
  return normalizedValue && normalizedValue.length > 0 ? normalizedValue : undefined;
}
