type RunState = { cancelRequested: boolean };

declare global {
  // eslint-disable-next-line no-var
  var __umActiveRuns: Map<string, RunState> | undefined;
}

const activeRuns: Map<string, RunState> =
  globalThis.__umActiveRuns ?? (globalThis.__umActiveRuns = new Map());

export function registerRun(runId: string) {
  activeRuns.set(runId, { cancelRequested: false });
}

export function requestRunCancel(runId: string): boolean {
  const run = activeRuns.get(runId);
  if (!run) return false;
  run.cancelRequested = true;
  return true;
}

export function isRunCancelled(runId: string): boolean {
  return activeRuns.get(runId)?.cancelRequested ?? false;
}

export function clearRun(runId: string) {
  activeRuns.delete(runId);
}
