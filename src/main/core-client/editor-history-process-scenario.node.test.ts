import { fork } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import type { LibraryStructuralHistoryToken } from "../../shared/library-module";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";

test("Core reclaims an authenticated Host's inverse after actual process death", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const child = fork(
      resolve(import.meta.dirname, "testing/editor-history-host-process.ts"),
      [
        ctx.profile.nodexHome,
        ctx.manifest.projectId,
        ctx.manifest.pageIdsByKey.source!,
        ctx.manifest.pageIdsByKey.child!,
        createUuidV7(),
      ],
      {
        execArgv: ["--import", "tsx"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let diagnostics = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-16_384);
    });
    const exited = once(child, "exit");
    try {
      const message = await Promise.race([
        once(child, "message", { signal: AbortSignal.timeout(15_000) }).then(
          ([value]) => value as LibraryStructuralHistoryToken,
        ),
        exited.then(() => {
          throw new Error(`History Host exited before receipt: ${diagnostics}`);
        }),
      ]);
      const library = createCoreLibraryModuleAdapter({
        client: ctx.runtime.clientForProject(ctx.manifest.projectId),
        ...ctx.runtime.identity,
      });
      const state = async () => {
        const result = await library.read({
          read: { mode: "structural_history_states", tokens: [message] },
        });
        if (!result.ok || result.value.value.kind !== "structural_history_states")
          throw new Error(JSON.stringify(result));
        return result.value.value.items[0]?.state;
      };
      expect(await state()).toBe("available");
      // This signal targets only the child created above, never the scenario
      // Core or any existing Nodex process. No close callback can run.
      expect(child.kill("SIGKILL")).toBe(true);
      await exited;
      await expect.poll(state, { timeout: 45_000, interval: 250 }).toBe("consumed");
      expect(await ctx.runtime.rootClient.health()).toBeDefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
}, 75_000);
