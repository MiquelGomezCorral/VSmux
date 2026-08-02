import type { TerminalEngine } from "./session-grid-contract";

/**
 * CDXC:Daemon-lifecycle 2026-07-29-21:45
 * Bump this whenever terminal-daemon-process behavior changes. The daemon is
 * intentionally reused across extension reloads when the protocol matches, so
 * behavior-only daemon fixes need a version change to replace old processes.
 */
export const TERMINAL_HOST_PROTOCOL_VERSION = 33;

export type TerminalSessionStatus = "starting" | "running" | "exited" | "error" | "disconnected";

export type TerminalSessionRestoreState = "live" | "replayed";

/**
 * CDXC:Agent-input-waiting 2026-07-31-14:11
 * A session is waiting only while its wrapped CLI exposes a structured prompt
 * that blocks on user input. This is distinct from completed attention and
 * must remain visible until the prompt is answered or the agent resumes.
 */
export type TerminalAgentStatus = "idle" | "working" | "waiting" | "attention";
export type TerminalAgentStatusSource = "structured" | "title";
export type TerminalAgentNotificationKind = "waiting" | "completion";

export type TerminalSessionSnapshot = {
  agentName?: string;
  agentStatus: TerminalAgentStatus;
  /**
   * CDXC:Agent-notifications 2026-07-31-14:30
   * Structured hook states must beat stale terminal titles, and notification
   * sounds are keyed by semantic state events instead of repeated rendering.
   */
  agentStatusSource?: TerminalAgentStatusSource;
  agentNotificationKind?: TerminalAgentNotificationKind;
  agentNotificationSequence?: number;
  cols: number;
  cwd: string;
  exitCode?: number;
  frontendAttachmentGeneration?: number;
  history?: string;
  isShellPromptIdle?: boolean;
  isAttached: boolean;
  restoreState: TerminalSessionRestoreState;
  rows: number;
  sessionId: string;
  shell: string;
  startedAt: string;
  status: TerminalSessionStatus;
  title?: string;
  workspaceId: string;
  endedAt?: string;
  errorMessage?: string;
};

export type TerminalSessionsBySessionId = Record<string, TerminalSessionSnapshot>;

export type TerminalHostAuthenticateRequest = {
  type: "authenticate";
  token: string;
  version: typeof TERMINAL_HOST_PROTOCOL_VERSION;
};

export type TerminalHostCreateOrAttachRequest = {
  type: "createOrAttach";
  requestId: string;
  sessionId: string;
  workspaceId: string;
  workspaceRoot?: string;
  cols: number;
  cwd: string;
  rows: number;
  sessionStateFilePath: string;
  shellIntegrationBinDir?: string;
  shellIntegrationZdotDir?: string;
  shell: string;
  shellArgs?: string[];
  terminalEngine: TerminalEngine;
  xtermHeadlessScrollback: number;
};

export type TerminalHostWriteRequest = {
  type: "write";
  workspaceId: string;
  sessionId: string;
  data: string;
};

export type TerminalHostResizeRequest = {
  type: "resize";
  workspaceId: string;
  sessionId: string;
  cols: number;
  rows: number;
};

export type TerminalHostKillRequest = {
  type: "kill";
  requestId: string;
  workspaceId: string;
  sessionId: string;
};

/**
 * CDXC:TerminalSleep 2026-07-31-13:24
 * Moon sleep ends the managed PTY so it stops work without adding tmux or
 * platform-specific process suspension. Wake starts a fresh PTY at the saved
 * directory and replays at most 512 KiB of scrollback; shell memory, jobs,
 * and in-flight processes cannot survive that boundary.
 */
export type TerminalHostSleepRequest = {
  type: "sleep";
  requestId: string;
  workspaceId: string;
  sessionId: string;
};

export type TerminalHostAcknowledgeAttentionRequest = {
  type: "acknowledgeAttention";
  workspaceId: string;
  sessionId: string;
};

export type TerminalHostListSessionsRequest = {
  type: "listSessions";
  requestId: string;
  workspaceId?: string;
};

export type TerminalHostConfigureRequest = {
  type: "configure";
  requestId: string;
  idleShutdownTimeoutMs: number | null;
};

export type TerminalHostSyncSessionLeasesRequest = {
  type: "syncSessionLeases";
  requestId: string;
  workspaceId: string;
  sessionIds: string[];
  leaseDurationMs: number | null;
};

export type TerminalHostSyncResizeEligibleSessionsRequest = {
  type: "syncResizeEligibleSessions";
  requestId: string;
  workspaceId: string;
  sessionIds: string[];
};

export type TerminalHostHeartbeatOwnerRequest = {
  type: "heartbeatOwner";
  requestId: string;
  workspaceId: string;
  ownerId: string;
  ownerPid: number;
};

export type TerminalHostRequest =
  | TerminalHostAuthenticateRequest
  | TerminalHostCreateOrAttachRequest
  | TerminalHostWriteRequest
  | TerminalHostResizeRequest
  | TerminalHostKillRequest
  | TerminalHostSleepRequest
  | TerminalHostAcknowledgeAttentionRequest
  | TerminalHostListSessionsRequest
  | TerminalHostConfigureRequest
  | TerminalHostSyncSessionLeasesRequest
  | TerminalHostSyncResizeEligibleSessionsRequest
  | TerminalHostHeartbeatOwnerRequest;

export type TerminalHostAuthenticatedEvent = {
  type: "authenticated";
};

export type TerminalHostResponse =
  | {
      type: "response";
      requestId: string;
      ok: true;
    }
  | {
      type: "response";
      requestId: string;
      ok: true;
      session: TerminalSessionSnapshot;
      didCreateSession: boolean;
    }
  | {
      type: "response";
      requestId: string;
      ok: true;
      sessions: TerminalSessionSnapshot[];
    }
  | {
      type: "response";
      requestId: string;
      ok: false;
      error: string;
    };

export type TerminalHostSessionOutputEvent = {
  type: "sessionOutput";
  sessionId: string;
  data: string;
};

export type TerminalHostSessionStateEvent = {
  type: "sessionState";
  session: TerminalSessionSnapshot;
};

export type TerminalHostEvent =
  | TerminalHostAuthenticatedEvent
  | TerminalHostResponse
  | TerminalHostSessionOutputEvent
  | TerminalHostSessionStateEvent;

export type TerminalInputMessage = {
  type: "terminalInput";
  sessionId: string;
  data: string;
};

export type TerminalResizeMessage = {
  type: "terminalResize";
  sessionId: string;
  cols: number;
  rows: number;
};

export type TerminalReadyMessage = {
  type: "terminalReady";
  sessionId: string;
  cols: number;
  rows: number;
};

export type TerminalStateMessage = {
  type: "terminalSessionState";
  session: TerminalSessionSnapshot;
};

export type TerminalOutputMessage = {
  type: "terminalOutput";
  sessionId: string;
  data: string;
};
