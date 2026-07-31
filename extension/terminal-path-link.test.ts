import { describe, expect, test } from "vite-plus/test";
import {
  isTerminalWorkspaceSearchTarget,
  isTrustedTerminalFileUriAuthority,
  resolveTerminalPathLink,
} from "./terminal-path-link";

describe("terminal path links", () => {
  test("resolves relative, absolute, and home-relative paths from trusted session state", () => {
    expect(resolveTerminalPathLink("workspace/main.ts", "/repo", "/Users/tester")).toBe(
      "/repo/workspace/main.ts",
    );
    expect(resolveTerminalPathLink("/tmp/main.ts", "/repo", "/Users/tester")).toBe("/tmp/main.ts");
    expect(resolveTerminalPathLink("~/repo/main.ts", "/repo", "/Users/tester")).toBe(
      "/Users/tester/repo/main.ts",
    );
  });

  test("leaves file URIs to VS Code URI parsing", () => {
    expect(
      resolveTerminalPathLink("file:///tmp/main.ts", "/repo", "/Users/tester"),
    ).toBeUndefined();
  });

  test("limits workspace searches to filename-shaped terminal words", () => {
    expect(isTerminalWorkspaceSearchTarget("main.ts")).toBe(true);
    expect(isTerminalWorkspaceSearchTarget("main.test.ts")).toBe(true);
    expect(isTerminalWorkspaceSearchTarget(".env")).toBe(true);
    expect(isTerminalWorkspaceSearchTarget("src/main.ts")).toBe(false);
    expect(isTerminalWorkspaceSearchTarget("../../main.ts")).toBe(false);
  });

  test("accepts local file URI authorities and Windows UNC paths only", () => {
    expect(isTrustedTerminalFileUriAuthority("", false)).toBe(true);
    expect(isTrustedTerminalFileUriAuthority("LOCALHOST", false)).toBe(true);
    expect(isTrustedTerminalFileUriAuthority("server", false)).toBe(false);
    expect(isTrustedTerminalFileUriAuthority("server", true)).toBe(true);
  });
});
