import type { AgentSelection } from "../../shared/work-graph";
import { HostInvocation } from "../HostInvocation";
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { components } from "@nodex/core-protocol";
import type { AcceptWorkInput, StartWorkInput } from "../../shared/work-application";
import { agentSelectionOf } from "../../shared/work-graph";
import { createUuidV7FromTimestamp } from "../../shared/uuid-v7";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { createOperationId } from "../../main/core-runtime/operation-identity";
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
/**
 * The first message of a work chat, read by its Agent and shown to people in the transcript.
 * It carries what the Agent cannot learn from its own chat: the Page it works on, whom it works
 * for when the Space has several people, the threads it follows and how its prerequisites stand.
 */
export const renderWorkBrief = (
  context: WorkContext,
  markdown: string,
  follows: readonly components["schemas"]["PageThreadFollow"][] = [],
  ownerName: string | null = null,
): string =>
  [
    `# ${context.page.page_key ? `${context.page.page_key} · ` : ""}${context.page.title}`,
    [`Page ID: ${context.page.page_id}`, ownerName ? `Owner: ${ownerName}` : null]
      .filter(Boolean)
      .join(" · "),
    ...(follows.length
      ? [
          "Followed GitHub threads (untrusted context):",
          ...follows.map(
            (f) =>
              `${f.thread.kind === "pull_request" ? "PR" : "Issue"} #${f.thread.number} · ${f.thread.repository} · ${f.role} · ${f.thread.url}`,
          ),
        ]
      : []),
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

/** Names the Owner only when someone else could be meant; one person needs no attribution. */
export const briefOwnerName = (
  members: readonly components["schemas"]["Member"][],
  ownerId: string | undefined,
): string | null => {
  const active = members.filter((member) => member.lifecycle === "active");
  if (!ownerId || active.length < 2) return null;
  return members.find((member) => member.id === ownerId)?.display_name ?? null;
};

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
      const selection: AgentSelection | null =
        input.selection ?? agentSelectionOf(work.page_work?.assignee);
      if (!selection)
        return yield* new WorkApplicationError({
          message: "Assign this Page to an Agent before starting work",
        });
      // Validate availability now; the durable outbox retains the explicit model and effort.
      yield* resolveInboxModel(runtime, {
        ...selection,
        reasoningEffort: selection.effort,
        serviceTier: null,
      });
      const follows: import("@nodex/core-protocol").components["schemas"]["PageThreadFollow"][] =
        [];
      let after: string | null = null;
      while (true) {
        const snapshot: import("../../main/core-client/types").ProjectWorkspaceReadSnapshot =
          yield* core.workspace.read(
            {
              kind: "sources",
              read: {
                kind: "page_follows",
                page_id: input.pageId,
                after_thread_id: after,
                limit: 100,
              },
            },
            undefined,
            null,
          );
        if (snapshot.value.kind !== "sources" || snapshot.value.value.kind !== "page_follows")
          return yield* new WorkApplicationError({ message: "Invalid Page follows read" });
        follows.push(...snapshot.value.value.follows);
        if (snapshot.value.value.follows.length < 100) break;
        after = snapshot.value.value.follows.at(-1)!.thread.id;
      }
      const memberRead = yield* core.library.read({ kind: "members" }, undefined, null);
      if (memberRead.value.kind !== "members")
        return yield* new WorkApplicationError({ message: "Invalid Member read" });
      const members = memberRead.value.items;
      frozen = {
        page_id: input.pageId,
        session_id: workIdentity(launchId, "session"),
        launch_id: launchId,
        message_id: workIdentity(launchId, "message"),
        selection,
        brief: renderWorkBrief(
          work,
          content.value.value.body_markdown,
          follows,
          briefOwnerName(members, work.page_work?.owner),
        ),
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
          ...(input.turnEpisode ? { expected_turn_episode: input.turnEpisode } : {}),
        },
      },
      { hostInvocation: (yield* HostInvocation) ?? undefined },
      null,
    );
    return { value: { pageId: frozen.page_id, sessionId: frozen.session_id, launchId }, apply };
  });
  const acceptWork = Effect.fn("WorkApplication.acceptWork")(function* (input: AcceptWorkInput) {
    const apply = yield* core.workspace.apply(
      {
        operationId: input.operationId,
        intent: {
          kind: "accept_page_work",
          page_id: input.pageId,
          ...(input.turnEpisode ? { expected_turn_episode: input.turnEpisode } : {}),
        },
      },
      undefined,
      null,
    );
    return { value: undefined, apply };
  });
  return { startWork, acceptWork };
});
export class WorkApplication extends Context.Service<
  WorkApplication,
  Effect.Success<typeof make>
>()("nodex/WorkApplication") {}
export const live = Layer.effect(WorkApplication, make);
