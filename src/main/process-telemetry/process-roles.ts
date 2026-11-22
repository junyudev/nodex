import { isDevRuntimeMetricsEnabled } from "../dev-runtime-metrics";

/** Child processes whose health readings Nodex reports by name rather than as other work. */
export type ProcessRole = "agent-runtime";

const running = new Map<ProcessRole, Set<number>>();
const starts = new Map<ProcessRole, number>();

/**
 * Where each named child process runs, recorded only while development runtime metrics are on.
 * A start after the first is a restart.
 */
export const processRoles = {
  enlist(role: ProcessRole, pid: number | undefined): () => void {
    if (pid === undefined || !isDevRuntimeMetricsEnabled()) return () => undefined;
    const pids = running.get(role) ?? new Set<number>();
    running.set(role, pids.add(pid));
    starts.set(role, (starts.get(role) ?? 0) + 1);
    return () => void pids.delete(pid);
  },
  pids: (role: ProcessRole): readonly number[] => [...(running.get(role) ?? [])],
  starts: (role: ProcessRole): number => starts.get(role) ?? 0,
};
