import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { startRuntimeWatchdog, type RuntimeWatchdog } from "./RuntimeWatchdog.ts";

let directory: string;
let watchdog: RuntimeWatchdog | undefined;
afterEach(() => {
  watchdog?.stop();
  watchdog = undefined;
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

const lines = (file: string) =>
  NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

it("reports a blocked control loop while it is blocked and records the stall afterwards", async () => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nodex-watchdog-"));
  const healthPath = NodePath.join(directory, "health.jsonl");
  const stallLogPath = NodePath.join(directory, "logs", "event-loop-stalls.log");
  const healthFd = NodeFS.openSync(healthPath, "w");
  try {
    watchdog = startRuntimeWatchdog({ healthFd, intervalMs: 100, stallLogPath });
    watchdog.queue(3, 1);
    // The first report precedes everything else, so the Host can judge silence from the start.
    await vi.waitFor(() => expect(lines(healthPath).length).toBeGreaterThan(0));

    // Block this thread the way a long synchronous step would.
    const until = performance.now() + 2_300;
    while (performance.now() < until) {
      /* The watchdog thread keeps reporting meanwhile. */
    }
    await vi.waitFor(() =>
      expect(
        lines(healthPath).some(
          (report) => report.type === "health" && Number(report.lagMs) >= 2_000,
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(lines(stallLogPath)).toContainEqual(
        expect.objectContaining({ phase: "ended", active: 3, waiting: 1 }),
      ),
    );
    const [stall] = lines(stallLogPath);
    expect(Number(stall!.gapMs)).toBeGreaterThanOrEqual(2_000);
    expect(stall).toHaveProperty("cpuMs");
    expect(stall).toHaveProperty("majorFaults");
  } finally {
    NodeFS.closeSync(healthFd);
  }
});
