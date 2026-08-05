import { describe, expect, test } from "vite-plus/test";
import {
  createAgentEnvironment,
  extractCodexSessionId,
  getCandidateExecutableNames,
  getProcessTreeKillTarget,
  isInteractiveOpenCodeInvocation,
  normalizeOpenCodeArguments,
  parseUnixProcessList,
  selectOpenCodeStateFileProcessGroups,
  shouldSpawnAgentInDetachedGroup,
} from "./agent-shell-wrapper-runner";

describe("getCandidateExecutableNames", () => {
  test("should prefer Windows PATHEXT launchers over the extensionless shim", () => {
    expect(getCandidateExecutableNames("codex", "win32", ".COM;.EXE;.BAT;.CMD")).toEqual([
      "codex.com",
      "codex.exe",
      "codex.bat",
      "codex.cmd",
    ]);
  });

  test("should keep the bare executable name on non-Windows platforms", () => {
    expect(getCandidateExecutableNames("codex", "linux")).toEqual(["codex"]);
    expect(getCandidateExecutableNames("gemini", "linux")).toEqual(["gemini"]);
  });

  test("should not include the extensionless codex shim on Windows", () => {
    expect(getCandidateExecutableNames("codex", "win32", ".CMD")).not.toContain("codex");
  });
});

describe("createAgentEnvironment", () => {
  test("should keep Claude terminal title changes enabled for sidebar status sync", () => {
    /**
     * CDXC:Claude-session-status 2026-04-25-08:10
     * Claude sidebar titles and working/done indicators depend on Claude Code's
     * own terminal-title updates, so the wrapper must not suppress them.
     */
    expect(createAgentEnvironment("claude", {}).CLAUDE_CODE_DISABLE_TERMINAL_TITLE).toBeUndefined();
  });

  test("should not add the Claude title override for other agents", () => {
    expect(createAgentEnvironment("codex", {}).CLAUDE_CODE_DISABLE_TERMINAL_TITLE).toBeUndefined();
    expect(createAgentEnvironment("gemini", {}).CLAUDE_CODE_DISABLE_TERMINAL_TITLE).toBeUndefined();
  });

  test("should stamp the wrapper pid into the environment for descendant cleanup", () => {
    expect(createAgentEnvironment("codex", {}).VSMUX_WRAPPER_PID).toBe(String(process.pid));
  });
});

describe("OpenCode lifecycle arguments", () => {
  test("normalizes an empty session argument to a fresh launch", () => {
    expect(normalizeOpenCodeArguments("opencode", ["-s", ""])).toEqual([]);
  });

  test("preserves a resolved OpenCode session id", () => {
    expect(normalizeOpenCodeArguments("opencode", ["-s", "ses_123"])).toEqual(["-s", "ses_123"]);
  });

  test("does not classify session listing as an interactive launch", () => {
    expect(isInteractiveOpenCodeInvocation(["session", "list", "--format", "json"])).toBe(false);
    expect(isInteractiveOpenCodeInvocation([])).toBe(true);
  });
});

describe("OpenCode state-file process groups", () => {
  test("selects only interactive OpenCode groups for the exact state file", () => {
    const stateFilePath = "/tmp/session-a.state";
    const processes = parseUnixProcessList(
      [
        "100 1 100 VSMUX_SESSION_STATE_FILE=/tmp/session-a.state node agent-shell-wrapper-runner.js --agent opencode",
        "101 100 100 VSMUX_SESSION_STATE_FILE=/tmp/session-a.state VSMUX_AGENT=opencode opencode -s ses_a",
        "102 100 100 VSMUX_SESSION_STATE_FILE=/tmp/session-a.state VSMUX_AGENT=opencode codegraph",
        "200 1 200 VSMUX_SESSION_STATE_FILE=/tmp/session-b.state VSMUX_AGENT=opencode opencode -s ses_b",
        "300 1 300 VSMUX_SESSION_STATE_FILE=/tmp/session-a.state VSMUX_AGENT=opencode opencode session list --format json",
        "400 1 400 VSMUX_SESSION_STATE_FILE=/tmp/session-a.state node agent-shell-wrapper-runner.js --agent opencode -- mcp auth local",
        "500 1 500 VSMUX_SESSION_STATE_FILE=/tmp/session-a.state.backup VSMUX_AGENT=opencode opencode -s ses_backup",
      ].join("\n"),
    );

    expect(selectOpenCodeStateFileProcessGroups(processes, stateFilePath)).toEqual([100]);
  });
});

describe("extractCodexSessionId", () => {
  test("returns the session id from session meta log lines", () => {
    expect(
      extractCodexSessionId(
        JSON.stringify({
          payload: {
            id: "019db54a-e2e1-78c1-b05b-61335c73ad3a",
          },
          type: "session_meta",
        }),
      ),
    ).toBe("019db54a-e2e1-78c1-b05b-61335c73ad3a");
  });

  test("ignores non session-meta log lines", () => {
    expect(
      extractCodexSessionId(
        JSON.stringify({
          payload: {
            turn_id: "turn-123",
          },
          type: "event_msg",
        }),
      ),
    ).toBeUndefined();
  });
});

describe("agent child process ownership", () => {
  test("should keep unix agents attached to the foreground terminal process group", () => {
    /**
     * CDXC:AgentTerminalResize 2026-04-29-08:19
     * Claude Code uses Ink/Node TTY resize signals to rewrap when embedded
     * terminals change columns. The wrapper must not detach interactive agents
     * because detached Unix children lose the controlling TTY and miss SIGWINCH.
     */
    expect(shouldSpawnAgentInDetachedGroup("darwin")).toBe(false);
    expect(shouldSpawnAgentInDetachedGroup("linux")).toBe(false);
  });

  test("should keep Windows agent launches attached to their direct pid", () => {
    expect(shouldSpawnAgentInDetachedGroup("win32")).toBe(false);
    expect(getProcessTreeKillTarget(4321, "win32")).toBe(4321);
  });

  test("should target the child pid on unix after preserving foreground TTY ownership", () => {
    expect(getProcessTreeKillTarget(4321, "darwin")).toBe(4321);
    expect(getProcessTreeKillTarget(-4321, "linux")).toBe(4321);
  });
});
