import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";
import type { TerminalSessionRecord } from "../shared/session-grid-contract";
import { updatePersistedSessionStateFile } from "./session-state-file";
import { getWorkspaceStorageKey } from "./terminal-workspace-environment";
import { VscodeNativeTerminalWorkspaceBackend } from "./vscode-native-terminal-workspace-backend";

vi.mock("vscode", () => {
  class TestEventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    public readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };

    public fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    public dispose(): void {
      this.listeners.clear();
    }
  }

  const openEmitter = new TestEventEmitter<any>();
  const closeEmitter = new TestEventEmitter<any>();
  const stateEmitter = new TestEventEmitter<any>();
  const startExecutionEmitter = new TestEventEmitter<any>();
  const endExecutionEmitter = new TestEventEmitter<any>();
  const terminals: any[] = [];
  const state = {
    shellIntegration: undefined as { executeCommand: ReturnType<typeof vi.fn> } | undefined,
  };

  const window = {
    terminals,
    createTerminal: vi.fn((options: any) => {
      const terminal = {
        creationOptions: options,
        dispose: vi.fn(() => {
          terminal.exitStatus = { code: 0 };
          const index = terminals.indexOf(terminal);
          if (index >= 0) {
            terminals.splice(index, 1);
          }
          closeEmitter.fire(terminal);
        }),
        exitStatus: undefined as { code: number } | undefined,
        name: options.name,
        processId: Promise.resolve(100 + terminals.length),
        sendText: vi.fn(),
        shellIntegration: state.shellIntegration,
        show: vi.fn(),
      };
      terminals.push(terminal);
      return terminal;
    }),
    onDidChangeTerminalState: stateEmitter.event,
    onDidCloseTerminal: closeEmitter.event,
    onDidEndTerminalShellExecution: endExecutionEmitter.event,
    onDidOpenTerminal: openEmitter.event,
    onDidStartTerminalShellExecution: startExecutionEmitter.event,
  };

  return {
    EventEmitter: TestEventEmitter,
    ThemeIcon: class {
      public constructor(public readonly id: string) {}
    },
    ViewColumn: { Active: -1 },
    window: {
      ...window,
      __emitClose: (terminal: any) => {
        const index = terminals.indexOf(terminal);
        if (index >= 0) {
          terminals.splice(index, 1);
        }
        closeEmitter.fire(terminal);
      },
      __emitOpen: (terminal: any) => openEmitter.fire(terminal),
      __reset: () => {
        terminals.splice(0, terminals.length);
        window.createTerminal.mockClear();
        state.shellIntegration = undefined;
      },
      __setShellIntegration: (shellIntegration: { executeCommand: ReturnType<typeof vi.fn> }) => {
        state.shellIntegration = shellIntegration;
      },
    },
    workspace: {
      getConfiguration: () => ({ get: (_key: string, defaultValue: unknown) => defaultValue }),
      workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
    },
  };
});

vi.mock("./agent-shell-integration", () => ({
  ensureAgentShellIntegration: vi.fn(async () => ({ binDir: "/vsmux/bin" })),
}));

vi.mock("./native-terminal-process-identity", () => ({
  readManagedTerminalIdentityFromProcessId: vi.fn(async () => undefined),
}));

const mockedWindow = vscode.window as typeof vscode.window & {
  __emitClose: (terminal: vscode.Terminal) => void;
  __emitOpen: (terminal: vscode.Terminal) => void;
  __reset: () => void;
  __setShellIntegration: (shellIntegration: { executeCommand: ReturnType<typeof vi.fn> }) => void;
};

let globalStoragePath: string;

describe("VscodeNativeTerminalWorkspaceBackend", () => {
  beforeEach(async () => {
    mockedWindow.__reset();
    globalStoragePath = await mkdtemp(path.join(tmpdir(), "vsmux-native-terminal-"));
  });

  afterEach(async () => {
    await rm(globalStoragePath, { force: true, recursive: true });
  });

  test("creates an anchor and native split without shell overrides", async () => {
    const shellIntegration = { executeCommand: vi.fn() };
    mockedWindow.__setShellIntegration(shellIntegration);
    const backend = createBackend();
    const firstSession = createSession("session-1", "First");
    const secondSession = createSession("session-2", "Second");

    await backend.initialize([firstSession, secondSession]);
    await backend.createOrAttachSession(firstSession, { cwd: "/workspace/one", groupId: "group-1" });
    await backend.createOrAttachSession(secondSession, { cwd: "/workspace/one", groupId: "group-1" });

    const terminals = mockedWindow.terminals as unknown as Array<vscode.Terminal>;
    expect(terminals).toHaveLength(2);
    expect(terminals[0].creationOptions.location).toEqual({ viewColumn: vscode.ViewColumn.Active });
    expect(terminals[1].creationOptions.location).toEqual({ parentTerminal: terminals[0] });
    expect(terminals[0].creationOptions.shellPath).toBeUndefined();
    expect(terminals[0].creationOptions.shellArgs).toBeUndefined();
    expect(terminals[0].creationOptions.env.PATH).toBeUndefined();
    expect(terminals[0].creationOptions.env.ZDOTDIR).toBeUndefined();
    expect(shellIntegration.executeCommand).toHaveBeenCalledWith("export PATH='/vsmux/bin':$PATH");

    backend.dispose();
  });

  test("focus waits for shell bootstrap before revealing the terminal", async () => {
    const shellIntegration = { executeCommand: vi.fn() };
    mockedWindow.__setShellIntegration(shellIntegration);
    const backend = createBackend();
    const session = createSession("session-1", "First");

    await backend.initialize([session]);
    await backend.createOrAttachSession(session, { cwd: "/workspace/one", groupId: "group-1" });
    const terminal = (mockedWindow.terminals as unknown as Array<vscode.Terminal>)[0];

    await backend.focusSession(session.sessionId);

    expect(shellIntegration.executeCommand).toHaveBeenCalledTimes(1);
    expect(terminal.show).toHaveBeenCalledWith(false);
    backend.dispose();
  });

  test("disposes a duplicate restored terminal without changing ownership", async () => {
    const backend = createBackend();
    const session = createSession("session-1", "First");

    await backend.initialize([session]);
    await backend.createOrAttachSession(session, { cwd: "/workspace/one", groupId: "group-1" });
    const original = (mockedWindow.terminals as unknown as Array<vscode.Terminal>)[0];
    const duplicate = mockedWindow.createTerminal({
      env: original.creationOptions.env,
      name: "Duplicate",
    });

    mockedWindow.__emitOpen(duplicate);
    await flush();

    expect(duplicate.dispose).toHaveBeenCalledTimes(1);
    expect(backend.hasLiveTerminal(session.sessionId)).toBe(true);
    backend.dispose();
  });

  test("promotes the next live session when the anchor closes", async () => {
    const backend = createBackend();
    const firstSession = createSession("session-1", "First");
    const secondSession = createSession("session-2", "Second");
    const thirdSession = createSession("session-3", "Third");

    await backend.initialize([firstSession, secondSession, thirdSession]);
    await backend.createOrAttachSession(firstSession, { cwd: "/workspace/one", groupId: "group-1" });
    await backend.createOrAttachSession(secondSession, { cwd: "/workspace/one", groupId: "group-1" });
    const firstTerminal = (mockedWindow.terminals as unknown as Array<vscode.Terminal>)[0];
    await backend.killSession(firstSession.sessionId);
    await backend.createOrAttachSession(thirdSession, { cwd: "/workspace/one", groupId: "group-1" });

    const terminals = mockedWindow.terminals as unknown as Array<vscode.Terminal>;
    expect(terminals).toHaveLength(2);
    expect(terminals[1].creationOptions.location).toEqual({ parentTerminal: terminals[0] });
    expect(terminals[0]).not.toBe(firstTerminal);
    backend.dispose();
  });

  test("retires a removed disconnected anchor before creating the next split", async () => {
    const backend = createBackend();
    const firstSession = createSession("session-1", "First");
    const secondSession = createSession("session-2", "Second");
    const thirdSession = createSession("session-3", "Third");

    await backend.initialize([firstSession, secondSession]);
    await backend.createOrAttachSession(firstSession, { cwd: "/workspace/one", groupId: "group-1" });
    await backend.createOrAttachSession(secondSession, { cwd: "/workspace/one", groupId: "group-1" });
    const terminals = mockedWindow.terminals as unknown as Array<vscode.Terminal>;
    (backend as unknown as { terminalsBySessionId: Map<string, vscode.Terminal> }).terminalsBySessionId.delete(
      firstSession.sessionId,
    );
    terminals.splice(0, 1);
    backend.syncSessions([secondSession]);
    await backend.createOrAttachSession(thirdSession, { cwd: "/workspace/one", groupId: "group-1" });

    expect(terminals).toHaveLength(2);
    expect(terminals[1].creationOptions.location).toEqual({ parentTerminal: terminals[0] });
    backend.dispose();
  });

  test("archives unexpected closes but not VSmux-initiated disposal", async () => {
    const backend = createBackend();
    const firstSession = createSession("session-1", "First");
    const secondSession = createSession("session-2", "Second");
    const closedSessionIds: string[] = [];

    await backend.initialize([firstSession, secondSession]);
    backend.onDidCloseSession?.((sessionId) => closedSessionIds.push(sessionId));
    await backend.createOrAttachSession(firstSession, { cwd: "/workspace/one", groupId: "group-1" });
    const firstTerminal = (mockedWindow.terminals as unknown as Array<vscode.Terminal>)[0];
    mockedWindow.__emitClose(firstTerminal);
    expect(closedSessionIds).toEqual([firstSession.sessionId]);

    await backend.createOrAttachSession(secondSession, { cwd: "/workspace/one", groupId: "group-1" });
    await backend.killSession(secondSession.sessionId);
    expect(closedSessionIds).toEqual([firstSession.sessionId]);
    backend.dispose();
  });

  test("preserves persisted metadata and cwd across restart", async () => {
    const shellIntegration = { executeCommand: vi.fn() };
    mockedWindow.__setShellIntegration(shellIntegration);
    const backend = createBackend();
    const session = createSession("session-1", "Record title");
    const statePath = path.join(
      globalStoragePath,
      getWorkspaceStorageKey("terminal-session-state", "workspace-1"),
      `${session.sessionId}.state`,
    );

    await backend.initialize([session]);
    await updatePersistedSessionStateFile(statePath, (state) => ({
      ...state,
      agentName: "codex",
      cwd: "/workspace/persisted",
      title: "Persisted title",
    }));
    await backend.createOrAttachSession(session, { cwd: "/workspace/initial", groupId: "group-1" });
    await backend.restartSession(session);

    const terminals = mockedWindow.terminals as unknown as Array<vscode.Terminal>;
    expect(terminals[0].creationOptions.cwd).toBe("/workspace/persisted");
    expect(backend.getSessionSnapshot(session.sessionId)?.title).toBe("Persisted title");
    expect(backend.getSessionSnapshot(session.sessionId)?.agentName).toBe("codex");
    backend.dispose();
  });
});

function createBackend(): VscodeNativeTerminalWorkspaceBackend {
  return new VscodeNativeTerminalWorkspaceBackend({
    context: {
      globalStorageUri: { fsPath: globalStoragePath },
    } as vscode.ExtensionContext,
    ensureShellSpawnAllowed: async () => true,
    workspaceId: "workspace-1",
    workspaceRoot: "/workspace",
  });
}

function createSession(sessionId: string, title: string): TerminalSessionRecord {
  return {
    alias: "",
    column: 0,
    createdAt: "2026-08-07T00:00:00.000Z",
    displayId: sessionId,
    isFavorite: false,
    kind: "terminal",
    row: 0,
    sessionId,
    slotIndex: 0,
    terminalEngine: "xterm",
    title,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
