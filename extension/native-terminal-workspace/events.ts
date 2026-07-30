import type { SessionRecord } from "../../shared/session-grid-contract";
import {
  getTitleDerivedSessionActivityFromTransition,
  haveSameTitleDerivedSessionActivity,
  type TitleDerivedSessionActivity,
} from "../session-title-activity";
import { syncKnownSessionActivities } from "./activity";

type SessionEventContext = {
  createSessionActivityContext: () => Parameters<typeof syncKnownSessionActivities>[0];
  getAllSessionRecords: () => SessionRecord[];
  refreshSidebar: () => Promise<void>;
  terminalTitleBySessionId: Map<string, string>;
  titleDerivedActivityBySessionId: Map<string, TitleDerivedSessionActivity>;
};

export async function handleBackendSessionsChanged(context: SessionEventContext): Promise<void> {
  await syncKnownSessionActivities(
    context.createSessionActivityContext(),
    context.getAllSessionRecords(),
    true,
  );
  await context.refreshSidebar();
}

export async function handleT3ActivityChanged(context: SessionEventContext): Promise<void> {
  await syncKnownSessionActivities(
    context.createSessionActivityContext(),
    context.getAllSessionRecords(),
    true,
  );
  await context.refreshSidebar();
}

export async function syncSessionTitle(
  context: SessionEventContext,
  sessionId: string,
  title: string,
): Promise<void> {
  const nextTitle = title.trim();
  if (!nextTitle) {
    return;
  }

  const previousTitle = context.terminalTitleBySessionId.get(sessionId);
  if (previousTitle === nextTitle) {
    return;
  }

  const previousDerivedActivity = context.titleDerivedActivityBySessionId.get(sessionId);
  const nextDerivedActivity = getTitleDerivedSessionActivityFromTransition(
    previousTitle,
    nextTitle,
    previousDerivedActivity,
  );
  context.terminalTitleBySessionId.set(sessionId, nextTitle);
  if (nextDerivedActivity) {
    context.titleDerivedActivityBySessionId.set(sessionId, nextDerivedActivity);
  } else {
    context.titleDerivedActivityBySessionId.delete(sessionId);
  }

  const titleActivityChanged = !haveSameTitleDerivedSessionActivity(
    previousDerivedActivity,
    nextDerivedActivity,
  );
  await syncKnownSessionActivities(
    context.createSessionActivityContext(),
    context.getAllSessionRecords(),
    true,
  );

  if (titleActivityChanged || previousTitle !== nextTitle) {
    await context.refreshSidebar();
  }
}
