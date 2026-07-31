/**
 * CDXC:TerminalLinks 2026-07-31-11:42
 * xterm's maintained web-links addon owns URL parsing and wrapped-buffer mapping.
 * VSmux owns only platform-specific activation so links require Cmd-click on macOS
 * and Ctrl-click elsewhere before opening outside VS Code.
 */
export function isPrimaryTerminalLinkActivation(
  event: Pick<MouseEvent, "altKey" | "button" | "ctrlKey" | "metaKey" | "shiftKey">,
  isMac: boolean,
): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.shiftKey &&
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}
