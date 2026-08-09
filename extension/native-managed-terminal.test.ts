import { describe, expect, test, vi } from "vite-plus/test";
import {
  createManagedTerminalEnvironment,
  disposeManagedTerminalsForWorkspace,
  getManagedTerminalIdentity,
} from "./native-managed-terminal";

describe("native managed terminal helpers", () => {
  test("should read session identity from shell-backed terminal creation options", () => {
    const identity = getManagedTerminalIdentity({
      creationOptions: {
        env: createManagedTerminalEnvironment(
          "workspace-1",
          "session-3",
          "/tmp/session-3.env",
          "/workspace",
        ),
        name: "Harbor Vale",
      },
    } as never);

    expect(identity).toEqual({
      sessionId: "session-3",
      workspaceId: "workspace-1",
    });
  });

  test("should preserve the optional native group identity", () => {
    const identity = getManagedTerminalIdentity({
      creationOptions: {
        env: createManagedTerminalEnvironment(
          "workspace-1",
          "session-3",
          "/tmp/session-3.env",
          "/workspace",
          "group-2",
        ),
        name: "Harbor Vale",
      },
    } as never);

    expect(identity).toEqual({
      groupId: "group-2",
      sessionId: "session-3",
      workspaceId: "workspace-1",
    });
  });

  test("should ignore extension-owned terminals", () => {
    const identity = getManagedTerminalIdentity({
      creationOptions: {
        name: "Harbor Vale",
        pty: {},
      },
    } as never);

    expect(identity).toBeUndefined();
  });

  test("should ignore terminals without both workspace and session markers", () => {
    const identity = getManagedTerminalIdentity({
      creationOptions: {
        env: {
          VSMUX_SESSION_ID: "session-3",
        },
        name: "Harbor Vale",
      },
    } as never);

    expect(identity).toBeUndefined();
  });

  test("should ignore terminals without managed env metadata", () => {
    const identity = getManagedTerminalIdentity({
      creationOptions: {
        name: "Harbor Vale",
      },
      name: "Harbor Vale",
    } as never);

    expect(identity).toBeUndefined();
  });

  test("should dispose only managed terminals from the requested workspace", async () => {
    const managedTerminal = {
      creationOptions: {
        env: createManagedTerminalEnvironment(
          "workspace-1",
          "session-3",
          "/tmp/session-3.env",
        ),
      },
      dispose: vi.fn(),
    };
    const otherWorkspaceTerminal = {
      creationOptions: {
        env: createManagedTerminalEnvironment(
          "workspace-2",
          "session-3",
          "/tmp/session-3.env",
        ),
      },
      dispose: vi.fn(),
    };
    const userTerminal = {
      creationOptions: { name: "User terminal" },
      dispose: vi.fn(),
    };

    expect(
      await disposeManagedTerminalsForWorkspace(
        [managedTerminal, otherWorkspaceTerminal, userTerminal] as never,
        "workspace-1",
      ),
    ).toBe(true);
    expect(managedTerminal.dispose).toHaveBeenCalledTimes(1);
    expect(otherWorkspaceTerminal.dispose).not.toHaveBeenCalled();
    expect(userTerminal.dispose).not.toHaveBeenCalled();
  });
});
