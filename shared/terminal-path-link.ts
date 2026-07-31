/**
 * CDXC:TerminalLinks 2026-07-31-13:45
 * Bare terminal filenames are searched through VS Code's glob API, so this shared
 * grammar permits common multi-dot and hidden filenames while excluding glob syntax.
 */
export const TERMINAL_WORKSPACE_FILENAME_SOURCE = String.raw`(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+|\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)`;

const terminalWorkspaceFilenamePattern = new RegExp(`^${TERMINAL_WORKSPACE_FILENAME_SOURCE}$`, "u");

export function isTerminalWorkspaceSearchTarget(target: string): boolean {
  return terminalWorkspaceFilenamePattern.test(target);
}
