import type { SidebarSessionItem } from "../shared/session-grid-contract";

export type GroupSessionSummary = {
  indicatorActivity: "attention" | "waiting" | "working" | undefined;
};

export function getGroupSessionSummary(
  sessions: readonly SidebarSessionItem[],
): GroupSessionSummary {
  let hasWorking = false;
  let hasAttention = false;
  let hasWaiting = false;

  for (const session of sessions) {
    if (session.activity === "waiting") {
      hasWaiting = true;
      continue;
    }

    if (session.activity === "working") {
      hasWorking = true;
      continue;
    }

    if (session.activity === "attention") {
      hasAttention = true;
    }
  }

  if (hasWaiting) {
    return { indicatorActivity: "waiting" };
  }

  if (hasAttention) {
    return { indicatorActivity: "attention" };
  }

  return { indicatorActivity: hasWorking ? "working" : undefined };
}
