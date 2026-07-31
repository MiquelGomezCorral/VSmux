/**
 * CDXC:TerminalLinks 2026-07-31-09:22
 * Terminal output is untrusted content. Only absolute HTTP(S) URLs may cross
 * the workspace webview boundary and open in the user's external browser.
 */
export function isSupportedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}
