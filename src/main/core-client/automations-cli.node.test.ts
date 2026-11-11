import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
import { runScenarioInbox } from "../../../scripts/scenarios/adapters/core-client-seed-runtime";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { AUTOMATIONS_ASK_IN_INBOX_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/automations-ask-in-inbox";
import { projectInbox } from "../../shared/inbox";
import { createUuidV7 } from "../../shared/uuid-v7";

const execute = promisify(execFile);
const mutationResult = z.object({
  ok: z.literal(true),
  result: z.object({
    duplicate: z.boolean(),
    item: z.object({
      automation_id: z.string(),
      held_decision: z.null(),
      next_run_at_ms: z.number().nullable(),
    }),
  }),
});

describe("Automations CLI over the clock and Inbox owners", () => {
  test("runs reviewed and failed Ask decisions once, even after they leave the Inbox", async () => {
    await withCoreScenario(
      { scenarioId: AUTOMATIONS_ASK_IN_INBOX_SCENARIO_ID },
      async (context) => {
        const scope = projectInbox(context.manifest.projectId);
        const automations = await context.seed.readAutomations();
        const expected = new Map<string, string>();
        for (const key of ["bumpDependencies", "releaseNotesDraft"] as const) {
          const id = context.manifest.entityIdsByKey?.[key];
          const pageId = context.manifest.pageIdsByKey[key];
          const automation = automations.find((candidate) => candidate.id === id);
          if (!automation?.heldDecision || !pageId) throw new Error("Missing waiting Automation");
          const message = (await context.seed.readInbox(scope)).items.find(
            (item) => item.pageId === pageId,
          );
          if (!message) throw new Error("Missing Inbox message");
          const prompt =
            key === "bumpDependencies" ? "Only update development dependencies" : automation.prompt;
          if (key === "bumpDependencies") {
            await runScenarioInbox(context.runtime, (inbox) =>
              inbox.edit({
                pageId,
                basis: message.basis,
                originalBody: message.body,
                body: prompt,
              }),
            );
          }
          expected.set(automation.heldDecision.dispatchId, prompt);
          const run = async () => {
            const { stdout } = await execute(
              requiredNativeExecutable("cli"),
              ["--json", "automations", "run", automation.id, "--idempotency-key", `cli:${key}`],
              {
                env: {
                  ...process.env,
                  NODEX_HOME: context.profile.nodexHome,
                  NODEX_AGENT_ENDPOINT: undefined,
                  NODEX_AGENT_CREDENTIAL: undefined,
                  NODEX_CLI_TASK_ID: undefined,
                  NODEX_CLI_TURN_ID: undefined,
                  NODEX_AGENT_SHELL: undefined,
                },
                cwd: context.profile.runRoot,
              },
            );
            return mutationResult.parse(JSON.parse(stdout)).result;
          };
          const first = await run();
          expect(first.duplicate).toBe(false);
          expect(first.item.automation_id).toBe(automation.id);
          expect(first.item.next_run_at_ms).toBe(automation.nextRunAt);
          const replay = await run();
          expect(replay.duplicate).toBe(true);
          expect(replay.item).toEqual(first.item);
          const decisions = await context.client.automationRead({
            kind: "automation_decisions",
            automation_id: automation.id,
            window: { first: 10 },
          });
          expect(decisions.value.kind).toBe("automation_decisions");
          if (decisions.value.kind !== "automation_decisions")
            throw new Error("Invalid decisions response");
          expect(decisions.value.window.items).toHaveLength(1);
          expect(decisions.value.window.items[0]).toMatchObject({
            dispatch_id: automation.heldDecision.dispatchId,
            status: "admitted",
          });
        }
        const due = await context.client.automationRead({ kind: "due_work", lane: "automations" });
        if (due.value.kind !== "due_work" || !due.value.plan.work_token)
          throw new Error("Missing admitted decisions");
        const claimed = await context.client.automationApply({
          operationId: createUuidV7(),
          intent: {
            kind: "claim_due",
            work_token: due.value.plan.work_token,
            limit: 10,
            lease_duration_ms: 60_000,
          },
        });
        expect(claimed.outcome.claimed_leases).toHaveLength(2);
        for (const lease of claimed.outcome.claimed_leases) {
          expect(expected.has(lease.dispatch_id)).toBe(true);
          expect(lease.admission?.prompt).toContain(expected.get(lease.dispatch_id));
        }
        expect(await runScenarioInbox(context.runtime, (inbox) => inbox.outbox(20))).toEqual([]);
      },
    );
  });
});
