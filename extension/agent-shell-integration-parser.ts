import { findOscTerminator, matchesLogPattern } from "./agent-shell-integration-utils";

type AgentLifecycleEventType = "start" | "stop" | "waiting" | "resume";

export type AgentLifecycleEvent = {
  agentName?: string;
  eventType: AgentLifecycleEventType;
};

export type ParsedAgentControlChunk = {
  events: AgentLifecycleEvent[];
  output: string;
  pending: string;
};

const AGENT_CONTROL_COMMAND = "9001";
const AGENT_CONTROL_NAMESPACE = "VSmux";
const CODEX_START_LOG_PATTERNS = [
  [`"type":"event_msg"`, `"payload":{"type":"task_started"`],
  [`"msg":{"type":"task_started"`],
  [`"msg":{"type":"exec_command_begin"`],
  [`"dir":"to_tui"`, `"kind":"app_event"`, `"variant":"TaskStarted"`],
] as const;
const CODEX_STOP_LOG_PATTERNS = [
  [`"type":"event_msg"`, `"payload":{"type":"task_complete"`],
  [`"msg":{"type":"task_complete"`],
  [`"msg":{"type":"turn_aborted"`],
  [`"dir":"to_tui"`, `"kind":"app_event"`, `"variant":"TaskComplete"`],
] as const;
/**
 * CDXC:Agent-input-waiting 2026-07-31-14:11
 * Codex TUI recording is the structured source for approval and question
 * blockers. It deliberately ignores text rendered by the agent itself.
 */
const CODEX_WAIT_LOG_PATTERNS = [
  [`"dir":"to_tui"`, `"kind":"app_event"`, `"variant":"ExecApprovalRequest"`],
  [`"dir":"to_tui"`, `"kind":"app_event"`, `"variant":"ApplyPatchApprovalRequest"`],
  [`"dir":"to_tui"`, `"kind":"app_event"`, `"variant":"RequestUserInput"`],
  [`"payload":{"type":"exec_approval_request"`],
  [`"payload":{"type":"apply_patch_approval_request"`],
  [`"payload":{"type":"request_user_input"`],
  [`"msg":{"type":"exec_approval_request"`],
  [`"msg":{"type":"apply_patch_approval_request"`],
  [`"msg":{"type":"request_user_input"`],
] as const;
const CODEX_RESUME_LOG_PATTERNS = [
  [`"dir":"from_tui"`, `"kind":"op"`, `"payload":{"ExecApproval"`],
  [`"dir":"from_tui"`, `"kind":"op"`, `"payload":{"PatchApproval"`],
  [`"dir":"from_tui"`, `"kind":"op"`, `"payload":{"UserInputAnswer"`],
] as const;

export function parseAgentControlChunk(data: string): ParsedAgentControlChunk {
  let index = 0;
  let output = "";
  const events: AgentLifecycleEvent[] = [];

  while (index < data.length) {
    if (data[index] !== "\u001b" || data[index + 1] !== "]") {
      output += data[index];
      index += 1;
      continue;
    }

    const controlStart = index;
    const terminator = findOscTerminator(data, controlStart + 2);
    if (!terminator) {
      return {
        events,
        output,
        pending: data.slice(controlStart),
      };
    }

    const controlBody = data.slice(controlStart + 2, terminator.contentEnd);
    const sequence = data.slice(controlStart, terminator.sequenceEnd);
    const parsedEvent = parseAgentControlEvent(controlBody);

    if (parsedEvent) {
      events.push(parsedEvent);
    } else {
      output += sequence;
    }

    index = terminator.sequenceEnd;
  }

  return {
    events,
    output,
    pending: "",
  };
}

export function detectCodexLifecycleEventFromLogLine(
  line: string,
): AgentLifecycleEventType | undefined {
  if (matchesLogPattern(line, CODEX_START_LOG_PATTERNS)) {
    return "start";
  }

  if (matchesLogPattern(line, CODEX_STOP_LOG_PATTERNS)) {
    return "stop";
  }

  if (matchesLogPattern(line, CODEX_WAIT_LOG_PATTERNS)) {
    return "waiting";
  }

  if (matchesLogPattern(line, CODEX_RESUME_LOG_PATTERNS)) {
    return "resume";
  }

  return undefined;
}

function parseAgentControlEvent(controlBody: string): AgentLifecycleEvent | undefined {
  const controlParts = controlBody.split(";");
  if (
    controlParts[0] !== AGENT_CONTROL_COMMAND ||
    controlParts[1] !== AGENT_CONTROL_NAMESPACE ||
    controlParts.length < 3
  ) {
    return undefined;
  }

  const normalizedEventType = normalizeLifecycleEventType(controlParts[2]);
  if (!normalizedEventType) {
    return undefined;
  }

  return {
    agentName: controlParts[3]?.trim() || undefined,
    eventType: normalizedEventType,
  };
}

function normalizeLifecycleEventType(
  value: string | undefined,
): AgentLifecycleEventType | undefined {
  switch (value?.trim().toLowerCase()) {
    case "start":
      return "start";
    case "stop":
      return "stop";
    case "wait":
    case "waiting":
      return "waiting";
    case "resume":
      return "resume";
    default:
      return undefined;
  }
}
