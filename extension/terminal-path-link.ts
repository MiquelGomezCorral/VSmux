import * as path from "node:path";

export { isTerminalWorkspaceSearchTarget } from "../shared/terminal-path-link";

/**
 * CDXC:TerminalLinks 2026-07-31-13:00
 * Terminal output is untrusted, so only the extension resolves a relative
 * target. The terminal's recorded cwd is the authority, never a webview value.
 */
export function resolveTerminalPathLink(
  target: string,
  cwd: string,
  homeDirectory: string,
): string | undefined {
  const normalizedTarget = target.trim();
  if (!normalizedTarget || /^file:\/\//iu.test(normalizedTarget)) {
    return undefined;
  }

  let expandedTarget = normalizedTarget;
  if (normalizedTarget === "~") {
    expandedTarget = homeDirectory;
  } else if (normalizedTarget.startsWith("~/") || normalizedTarget.startsWith("~\\")) {
    expandedTarget = path.join(homeDirectory, normalizedTarget.slice(2));
  }
  return path.isAbsolute(expandedTarget)
    ? path.normalize(expandedTarget)
    : path.resolve(cwd, expandedTarget);
}

/**
 * CDXC:TerminalLinks 2026-07-31-13:45
 * Terminal output may contain file URIs. localhost is always local, while a named
 * authority is a UNC path only on Windows and is rejected everywhere else.
 */
export function isTrustedTerminalFileUriAuthority(authority: string, isWindows: boolean): boolean {
  return authority === "" || authority.toLowerCase() === "localhost" || isWindows;
}
