import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { components } from "@nodex/core-protocol";
import { createUuidV7FromTimestamp } from "../../shared/uuid-v7";
import { resolveInboxModel } from "../inbox-application/InboxRuntimeSelection";

type WorkContext = components["schemas"]["PageWorkContext"];
type Launch = components["schemas"]["PageWorkLaunch"];
export class WorkApplicationError extends Schema.TaggedError<WorkApplicationError>()(
  "WorkApplicationError",
  { message: Schema.String },
) {}
export const workIdentity = (parent: string, purpose: string): string => {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["page-work", parent, purpose]))
    .digest();
  return createUuidV7FromTimestamp(0, bytes.readUInt32BE(0), bytes);
};
  [
    `# ${context.page.page_key ? `${context.page.page_key} · ` : ""}${context.page.title}`,
    markdown,
    ...(context.prerequisites.length
      ? [
          "## Prerequisites",
          ...context.prerequisites.map(
            ({ page, latest_report }) =>
              `### ${page.page_key ? `${page.page_key} · ` : ""}${page.title}\nPage ID: ${page.page_id}\nStatus: ${page.status ?? "unavailable"}${latest_report ? `\nLatest report (${latest_report.outcome}):\n${latest_report.summary}` : ""}`,
          ),
        ]
      : []),
  ]
    .filter(Boolean)
    .join("\n\n");

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const startWork = Effect.fn("WorkApplication.startWork")(function* (
    input: StartWorkInput & { readonly launchId?: string; readonly readinessEpoch?: string },
  ) {
    const operationId = input.operationId ?? createOperationId("work.start");
    const launchId = input.launchId ?? workIdentity(operationId, "launch");
    const existing = yield* core.workspace.read(
      { kind: "page_work_launch", launch_id: launchId },
      undefined,
      null,
    );
    if (existing.value.kind !== "page_work_launch")
      return yield* new WorkApplicationError({ message: "Invalid work launch read" });
    const retained = existing.value.launch;
    let frozen: Pick<
      Launch,
      "page_id" | "session_id" | "launch_id" | "message_id" | "brief" | "selection" | "again"
    >;
    if (retained) {
      if (
        retained.page_id !== input.pageId ||
        retained.again !== (input.again ?? false) ||
        (input.selection &&
          (input.selection.instanceId !== retained.selection.instanceId ||
            input.selection.model !== retained.selection.model ||
            input.selection.effort !== retained.selection.effort))
      )
        return yield* new WorkApplicationError({
          message: "Work identity is bound to another start",
        });
      frozen = {
        page_id: retained.page_id,
        session_id: retained.session_id,
        launch_id: retained.launch_id,
        message_id: retained.message_id,
        brief: retained.brief,
        selection: retained.selection,
        again: retained.again,
      };
    } else {
      const context = yield* core.database.read(
        { kind: "work_context", page_id: input.pageId },
        null,
      );
      if (context.value.kind !== "work_context")
        return yield* new WorkApplicationError({ message: "Invalid Page work context" });
      const work = context.value.value;
      const content = yield* core.library.read(
        { kind: "page_content", page_id: input.pageId },
        undefined,
        null,
      );
      if (content.value.kind !== "page_content")
        return yield* new WorkApplicationError({ message: "Invalid Page content read" });
      // Validate availability now; the durable outbox retains the explicit model and effort.
      yield* resolveInboxModel(runtime, {
        ...selection,
        reasoningEffort: selection.effort,
        serviceTier: null,
      });
      frozen = {
        page_id: input.pageId,
        session_id: workIdentity(launchId, "session"),
        launch_id: launchId,
        message_id: workIdentity(launchId, "message"),
        selection,
        again: input.again ?? false,
      };
    }
    const apply = yield* core.workspace.apply(
      {
        operationId,
        intent: {
          kind: "start_page_work",
          ...frozen,
          expected_readiness_epoch: input.readinessEpoch ?? null,
        },
      },
      null,
    );
    return { value: { pageId: frozen.page_id, sessionId: frozen.session_id, launchId }, apply };
  });
});
export class WorkApplication extends Context.Service<
  WorkApplication,
  Effect.Success<typeof make>
>()("nodex/WorkApplication") {}
export const live = Layer.effect(WorkApplication, make);
