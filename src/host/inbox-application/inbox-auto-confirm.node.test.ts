import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { DEFAULT_INBOX_SETTINGS, LIBRARY_INBOX, type InboxSettings } from "../../shared/inbox";
import { writeRoutingConsent } from "./InboxRoutingConsent";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { captureInbox, inboxOverRealCore } from "./InboxApplication.test-support";

type Provider = Effect.Success<ReturnType<AgentRuntimeApplication["Service"]["catalog"]>>[number];
const provider: Provider = {
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex",
  enabled: true,
  installed: true,
  status: "ready",
  version: "test",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-03T00:00:00.000Z",
  models: [{ slug: "model", name: "Model", isDefault: true, isCustom: false, capabilities: {} }],
  skills: [],
  slashCommands: [],
};
it.effect.each(["suggest", "act_on_requests"] as const)(
  "applies %s through the existing prepared confirmation and outbox",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        let current: InboxSettings = { ...DEFAULT_INBOX_SETTINGS, dispatchMode: mode };
        const { inbox, client, core, projectId } = yield* inboxOverRealCore(
          Effect.void,
          () => Effect.succeed([provider]),
          () => current,
        );
        yield* writeRoutingConsent(core, mode === "act_on_requests");
        const captured = yield* captureInbox(inbox, "Fix the README typo");
        const original = (yield* inbox.entry(captured.pageId))!;
        yield* inbox.requestSuggestion({
          requestId: createUuidV7(),
          mode: "auto",
          pageIds: [captured.pageId],
          basis: [original.basis],
        });
        const request = (yield* inbox.suggestionRequests(1))[0]!;
        yield* inbox.settleSuggestion({
          request_id: request.request_id,
          generation: request.generation,
          titles: [],
          suggestions: [
            {
              proposal_id: createUuidV7(),
              page_ids: [captured.pageId],
              action: {
                type: "new_chat",
                project_id: projectId,
                prompt: "Handle the attached request",
                additions: ["Optional extra lookup"],
                skills: [{ name: "review", reason: "An extra review." }],
              },
              entry_kind: "todo",
              summary: "Fix the typo",
              rationale: null,
              explicit_request: true,
            },
          ],
          produced_by: "Nodex",
          error: null,
          automatic_dispatch: mode === "act_on_requests",
        });
        assert.isTrue((yield* inbox.entry(captured.pageId))!.proposal!.explicitRequest);
        const candidates = yield* Effect.promise(() =>
          client.workspaceRead({ kind: "inbox_automatic_dispatches", limit: 100 }),
        );
        assert.equal(candidates.value.kind, "inbox_automatic_dispatches");
        if (candidates.value.kind === "inbox_automatic_dispatches")
          assert.lengthOf(candidates.value.proposals, mode === "act_on_requests" ? 1 : 0);
        if (mode === "act_on_requests") {
          const scopes = [
            { kind: "page", page_id: captured.pageId },
            { kind: "project", project_id: projectId },
            { kind: "space" },
          ] as const;
          for (const scope of scopes) {
            yield* core.workspace.apply(
              { operationId: `hold:${scope.kind}`, intent: { kind: "pause_work", scope } },
              undefined,
              null,
            );
            yield* inbox.autoConfirm;
            assert.equal((yield* inbox.entry(captured.pageId))!.proposal?.state, "open");
            assert.isEmpty(yield* inbox.outbox(16));
            yield* core.workspace.apply(
              { operationId: `resume:${scope.kind}`, intent: { kind: "resume_work", scope } },
              undefined,
              null,
            );
          }
        }
        yield* inbox.autoConfirm;
        yield* inbox.autoConfirm;
        const entry = (yield* inbox.entry(captured.pageId))!;
        if (mode === "suggest") {
          assert.equal(entry.proposal?.state, "open");
          assert.isNull(entry.proposal?.confirmedBy);
          assert.isEmpty(yield* inbox.outbox(16));
          current = { ...current, dispatchMode: "act_on_requests" };
          yield* writeRoutingConsent(core, true);
          yield* inbox.autoConfirm;
          assert.isEmpty(yield* inbox.outbox(16));
          return;
        }
        assert.equal(entry.proposal?.confirmedBy, "nodex");
        assert.equal(entry.proposal?.state, "dispatching");
        const [work] = yield* inbox.outbox(16);
        assert.isDefined(work);
        assert.isEmpty(work!.skill_invocations ?? []);
        assert.isEmpty("skills" in work!.action ? (work!.action.skills ?? []) : []);
        assert.notInclude(work!.final_text!, "Optional extra lookup");
        assert.include(work!.final_text!, "Fix the README typo");
        assert.equal(
          (yield* inbox.window({ scope: LIBRARY_INBOX, filter: "processed" })).items.length,
          1,
        );
      }),
    ),
);
