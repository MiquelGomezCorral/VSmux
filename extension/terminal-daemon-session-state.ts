import { normalizeTerminalTitle } from "../shared/session-grid-contract";
import type { TerminalAgentStatus, TerminalAgentStatusSource } from "../shared/terminal-host-protocol";
import { isGenericAgentSessionTitle } from "./first-prompt-session-title";
import type { PersistedSessionState } from "./session-state-file";

export type TerminalSessionPresentationStateInput = {
  lastKnownPersistedTitle?: string;
  liveTitle?: string;
  snapshotAgentName?: string;
  snapshotAgentStatus?: TerminalAgentStatus;
  snapshotAgentStatusSource?: TerminalAgentStatusSource;
  titleActivityAgentName?: string;
  titleActivityStatus?: TerminalAgentStatus;
};

/**
 * CDXC:Agent-input-waiting 2026-07-31-14:11
 * Hook and session-log blockers must win over stale spinner titles. Gemini
 * is the exception because its native action-required title is the blocker.
 */
export function shouldPreferPersistedSessionPresentation(
  currentState: PersistedSessionState,
): boolean {
  const agentName = currentState.agentName?.trim().toLowerCase();
  return (
    currentState.agentStatusSource === "structured" ||
    agentName === "opencode" ||
    (currentState.agentStatus === "waiting" && agentName !== "gemini")
  );
}

export function resolvePersistedSessionPresentationState(
  currentState: PersistedSessionState,
  input: TerminalSessionPresentationStateInput,
): PersistedSessionState {
  const sharedState = {
    ...(currentState.hasAutoTitleFromFirstPrompt === undefined
      ? {}
      : { hasAutoTitleFromFirstPrompt: currentState.hasAutoTitleFromFirstPrompt }),
    lastActivityAt: currentState.lastActivityAt,
    title: resolvePresentedSessionTitle(currentState, input),
  };

  if (shouldPreferPersistedSessionPresentation(currentState)) {
    return {
      agentName: currentState.agentName ?? input.snapshotAgentName ?? input.titleActivityAgentName,
      agentStatus: currentState.agentStatus,
      agentStatusSource: currentState.agentStatusSource ?? input.snapshotAgentStatusSource,
      agentNotificationKind: currentState.agentNotificationKind,
      agentNotificationSequence: currentState.agentNotificationSequence,
      ...sharedState,
    };
  }

  return {
    agentName: input.titleActivityAgentName ?? input.snapshotAgentName ?? currentState.agentName,
    agentStatus: input.titleActivityStatus ?? input.snapshotAgentStatus ?? currentState.agentStatus,
    agentStatusSource: input.titleActivityStatus
      ? "title"
      : (input.snapshotAgentStatusSource ?? currentState.agentStatusSource),
    agentNotificationKind: currentState.agentNotificationKind,
    agentNotificationSequence: currentState.agentNotificationSequence,
    ...sharedState,
  };
}

export function resolvePresentedSessionTitle(
  currentState: PersistedSessionState,
  input: TerminalSessionPresentationStateInput,
): string | undefined {
  const liveTitleAgentName =
    currentState.agentName ?? input.titleActivityAgentName ?? input.snapshotAgentName;
  const isLiveTitleGeneric = isGenericAgentSessionTitle(liveTitleAgentName, input.liveTitle);

  if (isLiveTitleGeneric) {
    return normalizeTerminalTitle(currentState.title ?? input.lastKnownPersistedTitle);
  }

  return normalizeTerminalTitle(
    input.liveTitle ?? input.lastKnownPersistedTitle ?? currentState.title,
  );
}
