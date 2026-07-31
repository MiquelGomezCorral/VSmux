import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { ILink } from "@xterm/xterm";
import { describe, expect, test, vi } from "vitest";
import { parseTerminalPathLinks, TerminalPathLinkProvider } from "./terminal-path-links";

describe("terminal path links", () => {
  test("recognizes the reported absolute path", () => {
    expect(
      parseTerminalPathLinks(
        "/Users/miquelgomezcorral/Documents/Yo/VSmux/workspace/xterm-terminal-pane.tsx",
        false,
      ),
    ).toMatchObject([
      {
        kind: "path",
        path: "/Users/miquelgomezcorral/Documents/Yo/VSmux/workspace/xterm-terminal-pane.tsx",
      },
    ]);
  });

  test("extracts line and column from common file link formats", () => {
    expect(parseTerminalPathLinks("src/example.ts:12:4", false)).toMatchObject([
      { column: 4, line: 12, path: "src/example.ts" },
    ]);
    expect(
      parseTerminalPathLinks('File "/tmp/path with spaces/example.ts", line 7, column 2', false),
    ).toMatchObject([{ column: 2, line: 7, path: "/tmp/path with spaces/example.ts" }]);
    expect(parseTerminalPathLinks("C:\\src\\example.ts(3, 5)", true)).toMatchObject([
      { column: 5, line: 3, path: "C:\\src\\example.ts" },
    ]);
  });

  test("recognizes unquoted diagnostic paths with spaces and delimiters", () => {
    const links = parseTerminalPathLinks("error: /Users/tester/My Folder/src/main.ts:12:4", false);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      column: 4,
      kind: "path",
      line: 12,
      path: "/Users/tester/My Folder/src/main.ts",
    });

    const delimitedLinks = parseTerminalPathLinks("at foo (src/main.ts:12:4)", false);
    expect(delimitedLinks).toHaveLength(1);
    expect(delimitedLinks[0]).toMatchObject({
      column: 4,
      kind: "path",
      line: 12,
      path: "src/main.ts",
    });
  });

  test("keeps multiple unquoted paths with spaces separate", () => {
    const links = parseTerminalPathLinks(
      "error: /tmp/My Folder/a.ts:1:1 at /tmp/Other Folder/b.ts:2:2",
      false,
    );

    expect(links).toHaveLength(2);
    expect(links.map(({ column, line, path }) => ({ column, line, path }))).toEqual([
      { column: 1, line: 1, path: "/tmp/My Folder/a.ts" },
      { column: 2, line: 2, path: "/tmp/Other Folder/b.ts" },
    ]);
  });

  test("recognizes file URIs, relative paths, and filename searches", () => {
    expect(parseTerminalPathLinks("file:///tmp/example.ts", false)).toMatchObject([
      { kind: "path", path: "file:///tmp/example.ts" },
    ]);
    expect(parseTerminalPathLinks("workspace/xterm-terminal-pane.tsx", false)).toMatchObject([
      { kind: "path", path: "workspace/xterm-terminal-pane.tsx" },
    ]);
    expect(parseTerminalPathLinks("example.ts", false)).toMatchObject([
      { kind: "search", path: "example.ts" },
    ]);
    expect(parseTerminalPathLinks("example.test.ts", false)).toMatchObject([
      { kind: "search", path: "example.test.ts" },
    ]);
    expect(parseTerminalPathLinks(".env", false)).toMatchObject([{ kind: "search", path: ".env" }]);
  });

  test("leaves HTTP URLs to the maintained web-links addon", () => {
    expect(parseTerminalPathLinks("https://example.com/path.ts", false)).toEqual([]);
    expect(parseTerminalPathLinks("(https://example.com/path.ts)", false)).toEqual([]);
  });

  test("maps a wrapped file path into an xterm link range", async () => {
    const terminal = new HeadlessTerminal({ cols: 20, rows: 5 });
    await new Promise<void>((resolve) => {
      terminal.write(
        "/Users/miquelgomezcorral/Documents/Yo/VSmux/workspace/xterm-terminal-pane.tsx",
        resolve,
      );
    });
    const activate = vi.fn();
    const provider = new TerminalPathLinkProvider({
      activate,
      isWindows: false,
      terminal: terminal as never,
    });
    const links = await new Promise<ILink[] | undefined>((resolve) =>
      provider.provideLinks(1, resolve),
    );

    expect(links).toHaveLength(1);
    expect(links?.[0]?.range.start.y).toBe(1);
    expect(links?.[0]?.range.end.y).toBeGreaterThan(1);
    links?.[0]?.activate({} as MouseEvent, links[0].text);
    expect(activate).toHaveBeenCalledOnce();
  });
});
