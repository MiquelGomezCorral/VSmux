import * as path from "node:path";
import * as vscode from "vscode";
import {
  getTerminalSessionSurfaceTitle,
  isTerminalSession,
  normalizeTerminalTitle,
  type SessionRecord,
  type TerminalSessionRecord,
} from "../shared/session-grid-contract";
import type {
  TerminalSessionSnapshot,
} from "../shared/terminal-host-protocol";
import { ensureAgentShellIntegration, type AgentShellIntegration } from "./agent-shell-integration";
import {
  createManagedTerminalEnvironment,
  getManagedTerminalIdentity,
  type ManagedTerminalIdentity,
} from "./native-managed-terminal";
import { readManagedTerminalIdentityFromProcessId } from "./native-terminal-process-identity";
import type {
  TerminalCreateOrAttachOptions,
  TerminalCreateOrAttachResult,
  TerminalWorkspaceBackend,
  TerminalWorkspaceBackendActivityChange,
  TerminalWorkspaceBackendPresentationChange,
  TerminalWorkspaceBackendTitleChange,
} from "./terminal-workspace-backend";
import {
  createDisconnectedSessionSnapshot,
  getDefaultWorkspaceCwd,
  getWorkspaceStorageKey,
} from "./terminal-workspace-environment";
import {
  deletePersistedSessionStateFile,
  deletePersistedShellStateFile,
  getPersistedShellStateFilePath,
  mergePersistedShellState,
  readPersistedSessionStateSnapshotFromFile,
  updatePersistedSessionStateFile,
  type PersistedSessionState,
} from "./session-state-file";
import {
  DaemonTerminalRuntime,
  type DaemonTerminalConnection,
  type TerminalDaemonState,
} from "./daemon-terminal-runtime";

const AGENT_STATE_DIR_NAME = "terminal-session-state";
const NATIVE_CONNECTION: DaemonTerminalConnection = {
  baseUrl: "",
  token: "",
};
const SHELL_INTEGRATION_TIMEOUT_MS = 3_000;

type NativeTerminalWorkspaceBackendOptions = {
  context: vscode.ExtensionContext;
  ensureShellSpawnAllowed: () => Promise<boolean>;
  workspaceId: string;
  workspaceRoot: string;
};

type ShellIntegrationReadiness = {
  promise: Promise<void>;
  resolve: () => void;
};

/**
 * CDXC:TerminalMigration 2026-08-07-14:11
 * The native pilot owns only terminals carrying VSmux identity metadata. It
 * uses VS Code's terminal split API and never repairs or moves workbench tabs.
 */
export class VscodeNativeTerminalWorkspaceBackend implements TerminalWorkspaceBackend {
  private agentShellIntegration: AgentShellIntegration | undefined;
  private readonly daemonRuntime: DaemonTerminalRuntime;
  private isDisposed = false;
  private readonly changeSessionsEmitter = new vscode.EventEmitter<void>();
  private readonly changeSessionActivityEmitter =
    new vscode.EventEmitter<TerminalWorkspaceBackendActivityChange>();
  private readonly changeSessionPresentationEmitter =
    new vscode.EventEmitter<TerminalWorkspaceBackendPresentationChange>();
  private readonly changeSessionTitleEmitter =
    new vscode.EventEmitter<TerminalWorkspaceBackendTitleChange>();
  private readonly closeSessionEmitter = new vscode.EventEmitter<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly expectedCloseTerminals = new Set<vscode.Terminal>();
  private readonly groupIdBySessionId = new Map<string, string>();
  private readonly anchorSessionIdByGroupId = new Map<string, string>();
  private readonly focusedSessionIdByGroupId = new Map<string, string>();
  private readonly lastTerminalActivityAtBySessionId = new Map<string, number>();
  private readonly sessionRecordBySessionId = new Map<string, TerminalSessionRecord>();
  private readonly sessions = new Map<string, TerminalSessionSnapshot>();
  private readonly terminalsBySessionId = new Map<string, vscode.Terminal>();
  private readonly sessionIdByTerminal = new Map<vscode.Terminal, string>();
  private readonly bootstrappedSessionIds = new Set<string>();
  private readonly trackingUnavailableSessionIds = new Set<string>();
  private readonly shellIntegrationReadinessBySessionId = new Map<
    string,
    ShellIntegrationReadiness
  >();
  private readonly shellIntegrationTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly sessionCreationPromises = new Map<
    string,
    Promise<TerminalCreateOrAttachResult>
  >();
  private refreshTimer: NodeJS.Timeout | undefined;

  public readonly onDidChangeSessionActivity = this.changeSessionActivityEmitter.event;
  public readonly onDidChangeSessionPresentation = this.changeSessionPresentationEmitter.event;
  public readonly onDidChangeSessionTitle = this.changeSessionTitleEmitter.event;
  public readonly onDidChangeSessions = this.changeSessionsEmitter.event;
  public readonly onDidCloseSession = this.closeSessionEmitter.event;

  public constructor(private readonly options: NativeTerminalWorkspaceBackendOptions) {
    this.daemonRuntime = new DaemonTerminalRuntime(
      options.context,
      options.workspaceId,
      options.workspaceRoot,
    );
  }

  public async initialize(sessionRecords: readonly SessionRecord[]): Promise<void> {
    /**
     * CDXC:TerminalMigration 2026-08-07-14:11
     * A workspace surface switch must not leave daemon PTYs alive beside the
     * native terminals. The runtime is scoped to this workspace and only
     * shuts down the existing daemon; it never starts one for native mode.
     */
    await this.daemonRuntime.shutdownExistingDaemon();
    this.agentShellIntegration = await ensureAgentShellIntegration(
      path.join(this.options.context.globalStorageUri.fsPath, "terminal-host-daemon"),
    );
    this.syncSessions(sessionRecords);
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        void this.attachManagedTerminal(terminal);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        this.handleTerminalClosed(terminal);
      }),
      vscode.window.onDidChangeTerminalState((terminal) => {
        void this.handleTerminalStateChanged(terminal);
      }),
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const sessionId = this.sessionIdByTerminal.get(event.terminal);
        if (!sessionId) {
          return;
        }

        void this.persistLastTerminalActivityAt(sessionId, Date.now());
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const sessionId = this.sessionIdByTerminal.get(event.terminal);
        if (!sessionId) {
          return;
        }

        void this.persistLastTerminalActivityAt(sessionId, Date.now());
      }),
    );

    for (const terminal of vscode.window.terminals) {
      await this.attachManagedTerminal(terminal);
    }
    await this.refreshSessionSnapshots();
    this.refreshTimer = setInterval(() => {
      void this.refreshSessionSnapshots();
    }, 500);
  }

  public dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const timeout of this.shellIntegrationTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.shellIntegrationTimeouts.clear();
    for (const sessionId of this.shellIntegrationReadinessBySessionId.keys()) {
      this.resolveShellIntegrationReadiness(sessionId);
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.daemonRuntime.dispose();
    this.closeSessionEmitter.dispose();
    this.changeSessionsEmitter.dispose();
    this.changeSessionActivityEmitter.dispose();
    this.changeSessionPresentationEmitter.dispose();
    this.changeSessionTitleEmitter.dispose();
  }

  public hasAttachedTerminal(sessionId: string): boolean {
    return this.isLiveTerminal(this.terminalsBySessionId.get(sessionId));
  }

  public getLastTerminalActivityAt(sessionId: string): number | undefined {
    return this.lastTerminalActivityAtBySessionId.get(sessionId);
  }

  public hasLiveTerminal(sessionId: string): boolean {
    return this.isLiveTerminal(this.terminalsBySessionId.get(sessionId));
  }

  public async acknowledgeAttention(sessionId: string): Promise<boolean> {
    const snapshot = this.sessions.get(sessionId);
    if (!snapshot || snapshot.agentStatus !== "attention") {
      return false;
    }

    await updatePersistedSessionStateFile(this.getSessionAgentStateFilePath(sessionId), (state) => ({
      ...state,
      agentStatus: "idle",
    }));
    await this.refreshSessionSnapshot(sessionId);
    return this.sessions.get(sessionId)?.agentStatus === "idle";
  }

  public async createOrAttachSession(
    sessionRecord: SessionRecord,
    options?: TerminalCreateOrAttachOptions,
  ): Promise<TerminalCreateOrAttachResult> {
    const existingCreation = this.sessionCreationPromises.get(sessionRecord.sessionId);
    if (existingCreation) {
      const result = await existingCreation;
      return { ...result, didCreateTerminal: false };
    }

    const creation = this.createOrAttachSessionInternal(sessionRecord, options);
    this.sessionCreationPromises.set(sessionRecord.sessionId, creation);
    try {
      return await creation;
    } finally {
      if (this.sessionCreationPromises.get(sessionRecord.sessionId) === creation) {
        this.sessionCreationPromises.delete(sessionRecord.sessionId);
      }
    }
  }

  /**
   * CDXC:TerminalMigration 2026-08-09-13:05
   * Reconciliation and focus can request the same missing terminal together;
   * one in-flight creation prevents duplicate native terminals and resumes.
   */
  private async createOrAttachSessionInternal(
    sessionRecord: SessionRecord,
    options?: TerminalCreateOrAttachOptions,
  ): Promise<TerminalCreateOrAttachResult> {
    if (!isTerminalSession(sessionRecord)) {
      return {
        didCreateTerminal: false,
        snapshot:
          this.sessions.get(sessionRecord.sessionId) ??
          createDisconnectedSessionSnapshot(sessionRecord.sessionId, this.options.workspaceId),
      };
    }

    this.upsertSession(sessionRecord, options?.groupId);
    const existing = await this.findExistingTerminal(sessionRecord.sessionId);
    if (existing) {
      await this.refreshSessionSnapshot(sessionRecord.sessionId);
      return {
        didCreateTerminal: false,
        snapshot: this.sessions.get(sessionRecord.sessionId)!,
      };
    }

    if (!(await this.options.ensureShellSpawnAllowed())) {
      const snapshot = {
        ...createDisconnectedSessionSnapshot(sessionRecord.sessionId, this.options.workspaceId, "error"),
        errorMessage: "Shell creation blocked in an untrusted workspace.",
      } satisfies TerminalSessionSnapshot;
      this.sessions.set(sessionRecord.sessionId, snapshot);
      this.changeSessionsEmitter.fire();
      return { didCreateTerminal: false, snapshot };
    }

    const groupId = options?.groupId ?? this.groupIdBySessionId.get(sessionRecord.sessionId);
    const parentTerminal = this.getGroupParentTerminal(groupId);
    let terminal: vscode.Terminal;
    try {
      terminal = vscode.window.createTerminal({
        cwd: options?.cwd ?? getDefaultWorkspaceCwd(),
        env: createManagedTerminalEnvironment(
          this.options.workspaceId,
          sessionRecord.sessionId,
          this.getSessionAgentStateFilePath(sessionRecord.sessionId),
          this.options.workspaceRoot,
          groupId,
        ),
        iconPath: new vscode.ThemeIcon("terminal"),
        location: parentTerminal
          ? { parentTerminal }
          : { viewColumn: vscode.ViewColumn.Active },
        name: getTerminalSessionSurfaceTitle(sessionRecord),
      });
    } catch (error) {
      const snapshot = {
        ...(this.sessions.get(sessionRecord.sessionId) ??
          createDisconnectedSessionSnapshot(sessionRecord.sessionId, this.options.workspaceId)),
        errorMessage: error instanceof Error ? error.message : String(error),
        isAttached: false,
        status: "error",
      } satisfies TerminalSessionSnapshot;
      this.sessions.set(sessionRecord.sessionId, snapshot);
      this.changeSessionsEmitter.fire();
      return { didCreateTerminal: false, snapshot };
    }
    this.bindTerminal(sessionRecord.sessionId, terminal, groupId);
    this.startShellIntegrationReadinessTimer(sessionRecord.sessionId);
    await this.bootstrapShellIntegration(sessionRecord.sessionId, terminal);
    await this.refreshSessionSnapshot(sessionRecord.sessionId, options?.cwd);
    return {
      didCreateTerminal: true,
      snapshot: this.sessions.get(sessionRecord.sessionId)!,
    };
  }

  public async focusSession(
    sessionId: string,
    shouldFocus: () => boolean = () => true,
  ): Promise<boolean> {
    if (!shouldFocus() || !this.isLiveTerminal(this.terminalsBySessionId.get(sessionId))) {
      return false;
    }

    await this.waitForShellIntegration(sessionId);
    const terminal = this.terminalsBySessionId.get(sessionId);
    if (!shouldFocus() || !this.isLiveTerminal(terminal)) {
      return false;
    }

    terminal.show(false);
    const groupId = this.groupIdBySessionId.get(sessionId);
    if (groupId) {
      this.focusedSessionIdByGroupId.set(groupId, sessionId);
    }
    return true;
  }

  public async applyFirstPromptAutoRename(sessionId: string, title: string): Promise<void> {
    const normalizedTitle = normalizeTerminalTitle(title) ?? title.trim();
    if (!normalizedTitle) {
      return;
    }

    await updatePersistedSessionStateFile(this.getSessionAgentStateFilePath(sessionId), (state) => ({
      ...state,
      hasAutoTitleFromFirstPrompt: true,
      pendingFirstPromptAutoRenamePrompt: undefined,
      title: normalizedTitle,
    }));
    await this.refreshSessionSnapshot(sessionId);
  }

  public async cancelPendingFirstPromptAutoRename(sessionId: string): Promise<void> {
    await updatePersistedSessionStateFile(this.getSessionAgentStateFilePath(sessionId), (state) => ({
      ...state,
      pendingFirstPromptAutoRenamePrompt: undefined,
    }));
  }

  public async markFirstPromptAutoRenameTriggered(sessionId: string): Promise<void> {
    await updatePersistedSessionStateFile(this.getSessionAgentStateFilePath(sessionId), (state) => ({
      ...state,
      hasAutoTitleFromFirstPrompt: true,
      pendingFirstPromptAutoRenamePrompt: undefined,
    }));
  }

  public getSessionSnapshot(sessionId: string): TerminalSessionSnapshot | undefined {
    return this.sessions.get(sessionId);
  }

  public async persistLastTerminalActivityAt(sessionId: string, activityAt: number): Promise<void> {
    if (!Number.isFinite(activityAt)) {
      return;
    }

    const persistedState = await updatePersistedSessionStateFile(
      this.getSessionAgentStateFilePath(sessionId),
      (state) => {
        const nextActivityAt = new Date(activityAt).toISOString();
        if (state.lastActivityAt && state.lastActivityAt >= nextActivityAt) {
          return state;
        }

        return { ...state, lastActivityAt: nextActivityAt };
      },
    );
    const parsedActivityAt = Date.parse(persistedState.lastActivityAt ?? "");
    if (!Number.isFinite(parsedActivityAt)) {
      return;
    }

    const previousActivityAt = this.lastTerminalActivityAtBySessionId.get(sessionId);
    if (previousActivityAt === parsedActivityAt) {
      return;
    }

    this.lastTerminalActivityAtBySessionId.set(sessionId, parsedActivityAt);
    this.changeSessionActivityEmitter.fire({ sessionId });
  }

  public async killSession(sessionId: string): Promise<void> {
    await this.disposeTerminal(sessionId);
    this.sessions.delete(sessionId);
    this.changeSessionsEmitter.fire();
  }

  public async sleepSession(sessionId: string): Promise<void> {
    await this.disposeTerminal(sessionId);
    this.sessions.set(
      sessionId,
      createDisconnectedSessionSnapshot(sessionId, this.options.workspaceId),
    );
    this.changeSessionsEmitter.fire();
  }

  public async deletePersistedSessionState(sessionId: string): Promise<void> {
    await deletePersistedSessionStateFile(this.getSessionAgentStateFilePath(sessionId));
  }

  public async renameSession(sessionRecord: SessionRecord): Promise<void> {
    if (!isTerminalSession(sessionRecord)) {
      return;
    }

    await this.cancelPendingFirstPromptAutoRename(sessionRecord.sessionId);
    await this.refreshSessionSnapshot(sessionRecord.sessionId);
  }

  public async restartSession(sessionRecord: SessionRecord): Promise<TerminalSessionSnapshot> {
    if (!isTerminalSession(sessionRecord)) {
      return (
        this.sessions.get(sessionRecord.sessionId) ??
        createDisconnectedSessionSnapshot(sessionRecord.sessionId, this.options.workspaceId)
      );
    }

    const groupId = this.groupIdBySessionId.get(sessionRecord.sessionId);
    const persistedState = await this.readPersistedSessionState(sessionRecord.sessionId);
    const cwd =
      persistedState.cwd?.trim() ||
      this.sessions.get(sessionRecord.sessionId)?.cwd?.trim() ||
      getDefaultWorkspaceCwd();
    await this.killSession(sessionRecord.sessionId);
    await deletePersistedShellStateFile(this.getSessionAgentStateFilePath(sessionRecord.sessionId));
    return (
      await this.createOrAttachSession(sessionRecord, { cwd, groupId })
    ).snapshot;
  }

  public syncSessions(sessionRecords: readonly SessionRecord[]): void {
    const nextTerminalRecords = sessionRecords.filter(isTerminalSession);
    const nextIds = new Set(nextTerminalRecords.map((record) => record.sessionId));
    for (const record of nextTerminalRecords) {
      this.upsertSession(record);
    }

    for (const sessionId of this.sessionRecordBySessionId.keys()) {
      if (nextIds.has(sessionId)) {
        continue;
      }

      this.promoteGroupAnchor(sessionId);
      const groupId = this.groupIdBySessionId.get(sessionId);
      if (groupId && this.focusedSessionIdByGroupId.get(groupId) === sessionId) {
        this.focusedSessionIdByGroupId.delete(groupId);
      }
      this.sessionRecordBySessionId.delete(sessionId);
      void this.disposeTerminal(sessionId);
      this.sessions.delete(sessionId);
      this.groupIdBySessionId.delete(sessionId);
    }
  }

  public async writeText(sessionId: string, data: string, shouldExecute = true): Promise<void> {
    const terminal = this.terminalsBySessionId.get(sessionId);
    if (!this.isLiveTerminal(terminal)) {
      return;
    }

    await this.waitForShellIntegration(sessionId);
    terminal.sendText(data, shouldExecute);
    await this.persistLastTerminalActivityAt(sessionId, Date.now());
  }

  public async getConnection(): Promise<DaemonTerminalConnection> {
    return { ...NATIVE_CONNECTION };
  }

  public async listGlobalSessions(): Promise<TerminalDaemonState> {
    return { isRunning: false, sessions: [] };
  }

  public async killGlobalSession(_workspaceId: string, _sessionId: string): Promise<void> {}

  public async shutdownDaemon(): Promise<boolean> {
    return false;
  }

  private upsertSession(sessionRecord: TerminalSessionRecord, groupId?: string): void {
    this.sessionRecordBySessionId.set(sessionRecord.sessionId, sessionRecord);
    if (groupId) {
      this.groupIdBySessionId.set(sessionRecord.sessionId, groupId);
    }
    this.sessions.set(
      sessionRecord.sessionId,
      this.sessions.get(sessionRecord.sessionId) ??
        createDisconnectedSessionSnapshot(sessionRecord.sessionId, this.options.workspaceId),
    );
  }

  private async attachManagedTerminal(terminal: vscode.Terminal): Promise<void> {
    const identity = await this.resolveManagedIdentity(terminal);
    if (!identity) {
      return;
    }

    if (terminal.exitStatus) {
      this.expectedCloseTerminals.add(terminal);
      terminal.dispose();
      return;
    }

    const existingTerminal = this.terminalsBySessionId.get(identity.sessionId);
    if (existingTerminal && existingTerminal !== terminal) {
      this.expectedCloseTerminals.add(terminal);
      terminal.dispose();
      return;
    }

    const record = this.sessionRecordBySessionId.get(identity.sessionId);
    if (!record) {
      return;
    }

    this.upsertSession(record, identity.groupId);
    this.bindTerminal(identity.sessionId, terminal, identity.groupId);
    this.startShellIntegrationReadinessTimer(identity.sessionId);
    await this.bootstrapShellIntegration(identity.sessionId, terminal);
    await this.refreshSessionSnapshot(identity.sessionId);
  }

  private async handleTerminalStateChanged(terminal: vscode.Terminal): Promise<void> {
    await this.attachManagedTerminal(terminal);
    const sessionId = this.sessionIdByTerminal.get(terminal);
    if (!sessionId) {
      return;
    }

    await this.bootstrapShellIntegration(sessionId, terminal);
    await this.refreshSessionSnapshot(sessionId);
  }

  private handleTerminalClosed(terminal: vscode.Terminal): void {
    const sessionId = this.sessionIdByTerminal.get(terminal);
    if (!sessionId) {
      this.expectedCloseTerminals.delete(terminal);
      return;
    }

    const wasExpected = this.expectedCloseTerminals.delete(terminal);
    this.sessionIdByTerminal.delete(terminal);
    if (this.terminalsBySessionId.get(sessionId) === terminal) {
      this.terminalsBySessionId.delete(sessionId);
    }
    const groupId = this.groupIdBySessionId.get(sessionId);
    if (groupId && this.focusedSessionIdByGroupId.get(groupId) === sessionId) {
      this.focusedSessionIdByGroupId.delete(groupId);
    }
    this.bootstrappedSessionIds.delete(sessionId);
    this.trackingUnavailableSessionIds.delete(sessionId);
    this.resolveShellIntegrationReadiness(sessionId);
    const timeout = this.shellIntegrationTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.shellIntegrationTimeouts.delete(sessionId);
    }

    const previousSnapshot = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      ...(previousSnapshot ?? createDisconnectedSessionSnapshot(sessionId, this.options.workspaceId)),
      endedAt: new Date().toISOString(),
      exitCode: terminal.exitStatus?.code,
      isAttached: false,
      status: terminal.exitStatus ? "exited" : "disconnected",
    });
    this.promoteGroupAnchor(sessionId);
    this.changeSessionsEmitter.fire();
    if (!wasExpected) {
      this.closeSessionEmitter.fire(sessionId);
    }
  }

  private bindTerminal(sessionId: string, terminal: vscode.Terminal, groupId?: string): void {
    const previousSessionId = this.sessionIdByTerminal.get(terminal);
    if (previousSessionId && previousSessionId !== sessionId) {
      this.terminalsBySessionId.delete(previousSessionId);
    }

    this.terminalsBySessionId.set(sessionId, terminal);
    this.sessionIdByTerminal.set(terminal, sessionId);
    if (groupId) {
      this.groupIdBySessionId.set(sessionId, groupId);
      if (!this.anchorSessionIdByGroupId.has(groupId)) {
        this.anchorSessionIdByGroupId.set(groupId, sessionId);
      }
    }
  }

  private promoteGroupAnchor(sessionId: string): void {
    const groupId = this.groupIdBySessionId.get(sessionId);
    if (!groupId || this.anchorSessionIdByGroupId.get(groupId) !== sessionId) {
      return;
    }

    const replacement = [...this.groupIdBySessionId.entries()].find(
      ([candidateSessionId, candidateGroupId]) =>
        candidateGroupId === groupId &&
        candidateSessionId !== sessionId &&
        this.hasLiveTerminal(candidateSessionId),
    )?.[0];
    if (replacement) {
      this.anchorSessionIdByGroupId.set(groupId, replacement);
    } else {
      this.anchorSessionIdByGroupId.delete(groupId);
    }
  }

  private getGroupParentTerminal(groupId: string | undefined): vscode.Terminal | undefined {
    if (!groupId) {
      return undefined;
    }

    const focusedSessionId = this.focusedSessionIdByGroupId.get(groupId);
    const focusedTerminal = focusedSessionId
      ? this.terminalsBySessionId.get(focusedSessionId)
      : undefined;
    if (this.isLiveTerminal(focusedTerminal)) {
      return focusedTerminal;
    }

    const anchorSessionId = this.anchorSessionIdByGroupId.get(groupId);
    const anchorTerminal = anchorSessionId
      ? this.terminalsBySessionId.get(anchorSessionId)
      : undefined;
    return this.isLiveTerminal(anchorTerminal) ? anchorTerminal : undefined;
  }

  private async findExistingTerminal(sessionId: string): Promise<vscode.Terminal | undefined> {
    const boundTerminal = this.terminalsBySessionId.get(sessionId);
    if (this.isLiveTerminal(boundTerminal)) {
      return boundTerminal;
    }

    for (const terminal of vscode.window.terminals) {
      const identity = await this.resolveManagedIdentity(terminal);
      if (identity?.sessionId === sessionId) {
        if (!this.isLiveTerminal(terminal)) {
          this.expectedCloseTerminals.add(terminal);
          terminal.dispose();
          continue;
        }

        await this.attachManagedTerminal(terminal);
        return this.terminalsBySessionId.get(sessionId);
      }
    }

    return undefined;
  }

  private async resolveManagedIdentity(
    terminal: vscode.Terminal,
  ): Promise<ManagedTerminalIdentity | undefined> {
    const creationIdentity = getManagedTerminalIdentity(terminal);
    if (
      creationIdentity?.workspaceId === this.options.workspaceId &&
      this.sessionRecordBySessionId.has(creationIdentity.sessionId)
    ) {
      return creationIdentity;
    }

    const processId = await terminal.processId;
    if (typeof processId !== "number" || processId <= 0) {
      return undefined;
    }

    const processIdentity = await readManagedTerminalIdentityFromProcessId(processId);
    return processIdentity?.workspaceId === this.options.workspaceId &&
      this.sessionRecordBySessionId.has(processIdentity.sessionId)
      ? processIdentity
      : undefined;
  }

  private async bootstrapShellIntegration(
    sessionId: string,
    terminal: vscode.Terminal,
  ): Promise<void> {
    if (this.bootstrappedSessionIds.has(sessionId)) {
      return;
    }

    const shellIntegration = terminal.shellIntegration;
    const binDir = this.agentShellIntegration?.binDir;
    if (!shellIntegration || !binDir) {
      return;
    }

    const pathPrefix = quoteShellValue(binDir);
    const command = process.platform === "win32"
      ? `$env:Path = ${quotePowerShellValue(binDir)} + ";" + $env:Path`
      : `export PATH=${pathPrefix}:$PATH`;
    shellIntegration.executeCommand(command);
    this.bootstrappedSessionIds.add(sessionId);
    this.trackingUnavailableSessionIds.delete(sessionId);
    this.resolveShellIntegrationReadiness(sessionId);
    await this.refreshSessionSnapshot(sessionId);
  }

  private startShellIntegrationReadinessTimer(sessionId: string): void {
    if (!this.shellIntegrationReadinessBySessionId.has(sessionId)) {
      let resolveReadiness!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolveReadiness = resolve;
      });
      this.shellIntegrationReadinessBySessionId.set(sessionId, {
        promise,
        resolve: resolveReadiness,
      });
    }

    const previousTimeout = this.shellIntegrationTimeouts.get(sessionId);
    if (previousTimeout) {
      clearTimeout(previousTimeout);
    }

    const timeout = setTimeout(() => {
      if (this.bootstrappedSessionIds.has(sessionId) || !this.hasLiveTerminal(sessionId)) {
        return;
      }

      this.trackingUnavailableSessionIds.add(sessionId);
      this.resolveShellIntegrationReadiness(sessionId);
      void this.refreshSessionSnapshot(sessionId);
    }, SHELL_INTEGRATION_TIMEOUT_MS);
    this.shellIntegrationTimeouts.set(sessionId, timeout);
  }

  private async waitForShellIntegration(sessionId: string): Promise<void> {
    await this.shellIntegrationReadinessBySessionId.get(sessionId)?.promise;
  }

  private resolveShellIntegrationReadiness(sessionId: string): void {
    const readiness = this.shellIntegrationReadinessBySessionId.get(sessionId);
    if (!readiness) {
      return;
    }

    readiness.resolve();
    this.shellIntegrationReadinessBySessionId.delete(sessionId);
    const timeout = this.shellIntegrationTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.shellIntegrationTimeouts.delete(sessionId);
    }
  }

  private async disposeTerminal(sessionId: string): Promise<void> {
    this.bootstrappedSessionIds.delete(sessionId);
    this.trackingUnavailableSessionIds.delete(sessionId);
    const groupId = this.groupIdBySessionId.get(sessionId);
    if (groupId && this.focusedSessionIdByGroupId.get(groupId) === sessionId) {
      this.focusedSessionIdByGroupId.delete(groupId);
    }
    const terminal = this.terminalsBySessionId.get(sessionId);
    if (!terminal) {
      this.resolveShellIntegrationReadiness(sessionId);
      return;
    }

    this.resolveShellIntegrationReadiness(sessionId);
    this.expectedCloseTerminals.add(terminal);
    terminal.dispose();
    this.terminalsBySessionId.delete(sessionId);
    this.sessionIdByTerminal.delete(terminal);
    this.promoteGroupAnchor(sessionId);
  }

  private async refreshSessionSnapshots(): Promise<void> {
    for (const sessionId of this.sessionRecordBySessionId.keys()) {
      await this.refreshSessionSnapshot(sessionId);
    }
  }

  private async refreshSessionSnapshot(sessionId: string, creationCwd?: string): Promise<void> {
    const record = this.sessionRecordBySessionId.get(sessionId);
    if (!record) {
      return;
    }

    const persistedState = await this.readPersistedSessionState(sessionId);
    const previousSnapshot = this.sessions.get(sessionId);
    const terminal = this.terminalsBySessionId.get(sessionId);
    const isLive = this.isLiveTerminal(terminal);
    const nextSnapshot: TerminalSessionSnapshot = {
      ...(previousSnapshot ?? createDisconnectedSessionSnapshot(sessionId, this.options.workspaceId)),
      agentName: persistedState.agentName,
      agentNotificationKind: persistedState.agentNotificationKind,
      agentNotificationSequence: persistedState.agentNotificationSequence,
      agentStatus: persistedState.agentStatus,
      agentStatusSource: persistedState.agentStatusSource,
      cwd: persistedState.cwd ?? creationCwd ?? previousSnapshot?.cwd ?? getDefaultWorkspaceCwd(),
      endedAt: isLive ? undefined : previousSnapshot?.endedAt,
      errorMessage: this.trackingUnavailableSessionIds.has(sessionId)
        ? "Native shell integration is unavailable; agent tracking is unavailable."
        : undefined,
      exitCode: isLive ? undefined : previousSnapshot?.exitCode,
      isAttached: isLive,
      isShellPromptIdle: persistedState.isShellPromptIdle,
      restoreState: "live",
      startedAt: previousSnapshot?.startedAt ?? new Date().toISOString(),
      status: isLive
        ? "running"
        : previousSnapshot?.status === "exited"
          ? "exited"
          : "disconnected",
      title: persistedState.title ?? normalizeTerminalTitle(record.title),
      workspaceId: this.options.workspaceId,
    };
    this.sessions.set(sessionId, nextSnapshot);

    const previousNotificationId = getNotificationId(previousSnapshot);
    const nextNotificationId = getNotificationId(nextSnapshot);
    if (nextNotificationId && nextNotificationId !== previousNotificationId) {
      this.changeSessionActivityEmitter.fire({
        kind: nextSnapshot.agentNotificationKind,
        notificationId: nextNotificationId,
        sessionId,
      });
    }

    if (previousSnapshot?.agentName !== nextSnapshot.agentName ||
        previousSnapshot?.agentStatus !== nextSnapshot.agentStatus ||
        previousSnapshot?.title !== nextSnapshot.title) {
      this.changeSessionPresentationEmitter.fire({
        sessionId,
        title: nextSnapshot.title,
      });
      this.changeSessionTitleEmitter.fire({
        sessionId,
        title: nextSnapshot.title,
      });
    }

    if (JSON.stringify(previousSnapshot) !== JSON.stringify(nextSnapshot)) {
      this.changeSessionsEmitter.fire();
    }
  }

  private async readPersistedSessionState(sessionId: string): Promise<PersistedSessionState> {
    const sessionStateFilePath = this.getSessionAgentStateFilePath(sessionId);
    const [sessionState, shellState] = await Promise.all([
      readPersistedSessionStateSnapshotFromFile(sessionStateFilePath),
      readPersistedSessionStateSnapshotFromFile(getPersistedShellStateFilePath(sessionStateFilePath)),
    ]);
    return mergePersistedShellState(sessionState.state, shellState.state);
  }

  private getSessionAgentStateFilePath(sessionId: string): string {
    return path.join(
      this.options.context.globalStorageUri.fsPath,
      getWorkspaceStorageKey(AGENT_STATE_DIR_NAME, this.options.workspaceId),
      `${sessionId}.state`,
    );
  }

  private isLiveTerminal(terminal: vscode.Terminal | undefined): terminal is vscode.Terminal {
    return Boolean(terminal && !terminal.exitStatus && vscode.window.terminals.includes(terminal));
  }
}

function getNotificationId(snapshot: TerminalSessionSnapshot | undefined): string | undefined {
  if (!snapshot?.agentNotificationKind || snapshot.agentNotificationSequence === undefined) {
    return undefined;
  }

  return `${snapshot.agentStatusSource ?? "unknown"}:${snapshot.agentNotificationSequence}:${snapshot.agentNotificationKind}`;
}

function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quotePowerShellValue(value: string): string {
  return `"${value.replaceAll('"', '""')}` + `"`;
}
