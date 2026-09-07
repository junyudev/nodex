import * as Effect from "effect/Effect";
import { nodexAgentAuthorityFingerprint } from "../../shared/nodex-agent-authority";
import { workbenchObservationSchemas } from "../../shared/nodex-app-tools/workbench-observation-schemas";
import { workbenchControlSchemas } from "../../shared/nodex-app-tools/workbench-control-schemas";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { NodexAppToolAuthority } from "./NodexAppToolAuthority";
import { WorkbenchObservation } from "./WorkbenchObservation";
import { make as makeSelection } from "./WorkbenchSceneSelection";
import { make as makeDescription } from "./WorkbenchTabDescription";
import {
  readWorkbenchObservationPage,
  workbenchObservationHandle,
} from "./workbench-observation-page";
import { toolFailure, toolSuccess } from "./app-tool-result";
import { make as makeControl } from "./WorkbenchControl";
import { WorkbenchContentAccess } from "./WorkbenchContentAccess";
import { make as makeContentRead } from "./WorkbenchContentRead";
import { sessionPresentationSchemas } from "../../shared/nodex-app-tools/session-presentation-schemas";
import { make as makeSessionPresentation } from "./SessionPresentationAppTools";

export const make = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const turns = yield* CodexTurnAuthority;
  const presentation = yield* CodexTurnPresentation;
  const identity = yield* CoreAuthority;
  const authorityOwner = yield* NodexAppToolAuthority;
  const observations = yield* WorkbenchObservation;
  const select = yield* makeSelection;
  const describe = yield* makeDescription;
  const control = yield* makeControl;
  const contentAccess = yield* WorkbenchContentAccess;
  const contentRead = yield* makeContentRead;
  const sessionPresentation = yield* makeSessionPresentation;

  return Effect.fn("WorkbenchAppTools.execute")(function* (input: AppToolInvocation) {
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const schemas = {
      ...workbenchObservationSchemas,
      ...workbenchControlSchemas,
      ...sessionPresentationSchemas,
    };
    if (!Object.hasOwn(schemas, input.name)) return toolFailure("unknown_tool");
    const inputSchema = schemas[input.name as keyof typeof schemas];
    if (!inputSchema.safeParse(input.arguments).success) return toolFailure("invalid_arguments");
    const authority = yield* turns
      .capture(input.caller.threadId, input.caller.turnId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!authority) return toolFailure("authority_unavailable");
    const fingerprint = nodexAgentAuthorityFingerprint(authority);
    const isCurrent = Effect.gen(function* () {
      if (!input.caller.isActive()) return false;
      const current = yield* turns
        .capture(input.caller.threadId, input.caller.turnId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      return (
        current !== null &&
        nodexAgentAuthorityFingerprint(current) === fingerprint &&
        input.caller.isActive()
      );
    });
    const bound = yield* authorityOwner.bind({
      authority,
      callId: input.caller.callId,
      presentation: null,
      isCurrent,
    });
    if (!bound.authority) return toolFailure("authority_unavailable");
    const principal = {
      profileId: identity.identity.profileId,
      authorityFingerprint: fingerprint,
      hostId: input.caller.hostId,
      backendGeneration: input.caller.generation,
    };
    if (Object.hasOwn(sessionPresentationSchemas, input.name))
      return yield* sessionPresentation({
        invocation: input,
        principal,
        authority,
        taskAccess: bound.resourceAccess,
        isCurrent,
      }).pipe(Effect.catch((error) => Effect.succeed(toolFailure(error.reason))));
    if (Object.hasOwn(workbenchControlSchemas, input.name))
      return yield* control({
        invocation: input,
        principal,
        authority,
        taskAccess: bound.resourceAccess,
        isCurrent,
      }).pipe(Effect.catch((error) => Effect.succeed(toolFailure(error.reason))));
    const describeTab = (
      record: {
        observationId: string;
        reference: { sceneOwner: Parameters<typeof describe>[0]["sceneOwner"] };
      },
      tab: Parameters<typeof describe>[0]["tab"],
      requireExactTarget = false,
    ) =>
      describe({
        observationId: record.observationId,
        sceneOwner: record.reference.sceneOwner,
        tab,
        authority,
        callId: input.caller.callId,
        taskAccess: bound.resourceAccess,
        requireExactTarget,
      });
    const run = Effect.gen(function* () {
      if (input.name === "read_tab_content" || input.name === "query_displayed_view") {
        const queryView = input.name === "query_displayed_view";
        const parsed = workbenchObservationSchemas[input.name].safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        const record = yield* observations.resolve(principal, parsed.data.observationId);
        const tab = record.observation.tabs.find(
          (candidate) =>
            workbenchObservationHandle(record.observationId, "tab", candidate.tabId) ===
            parsed.data.tabId,
        );
        if (!tab) return toolFailure("tab_unavailable");
        const surface = tab.surface;
        if (
          !surface ||
          (surface.kind !== "page_stage" &&
            surface.kind !== "db_view" &&
            surface.kind !== "canvas_stage")
        )
          return toolFailure("unsupported_surface");
        if (queryView && surface.kind !== "db_view") return toolFailure("unsupported_surface");
        if (surface.kind !== "db_view" && "view" in parsed.data && parsed.data.view !== undefined)
          return toolFailure("invalid_arguments");
        if (
          surface.kind === "db_view" &&
          (("format" in parsed.data && parsed.data.format !== undefined) ||
            ("page" in parsed.data && parsed.data.page !== undefined))
        )
          return toolFailure("invalid_arguments");
        const description = yield* contentAccess.describe({
          authority,
          callId: input.caller.callId,
          taskAccess: bound.resourceAccess,
          surface,
        });
        const viewOptions = "view" in parsed.data ? parsed.data.view : undefined;
        const content = yield* (queryView ? contentRead.query : contentRead.read)({
          authority,
          callId: input.caller.callId,
          taskAccess: bound.resourceAccess,
          description,
          live: {
            reference: record.reference,
            tabId: tab.tabId,
            expectedPresentationRevision: record.observation.presentationRevision,
          },
          format: "format" in parsed.data ? parsed.data.format : undefined,
          page: "page" in parsed.data ? parsed.data.page : undefined,
          ...(queryView
            ? {
                propertyIds: "propertyIds" in parsed.data ? parsed.data.propertyIds : undefined,
                limit: "limit" in parsed.data ? parsed.data.limit : undefined,
              }
            : viewOptions),
          isCurrent,
        });
        if (content.status === "failed")
          return toolFailure(content.error.code, content.error.message);
        if (content.status !== "ready") return toolFailure(content.status);
        return toolSuccess({
          observationId: record.observationId,
          tabId: parsed.data.tabId,
          ...content,
        });
      }
      if (input.name === "get_session_context") {
        const parsed = workbenchObservationSchemas.get_session_context.safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        const thread = yield* workspace
          .getThread(input.caller.threadId)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!thread?.sessionId) return toolFailure("session_unavailable");
        const anchor = presentation.read(input.caller.threadId, input.caller.turnId);
        const selected = yield* select({ sessionId: thread.sessionId, anchor, ...parsed.data });
        const execution = {
          sessionId: thread.sessionId,
          threadId: input.caller.threadId,
          turnId: input.caller.turnId,
          projectId: thread.projectId,
          executionProjectId: thread.projectId,
          hostId: input.caller.hostId,
          cwd: thread.cwd,
        };
        if (selected.status !== "selected")
          return toolSuccess({ ...execution, presentation: selected }, 24 * 1024);
        const record = yield* observations.capture(principal, selected.reference);
        const observed = record.observation;
        const anchored = anchor !== null && parsed.data.mode === "anchored" && !parsed.data.target;
        const selectedTabs = anchored
          ? anchor.selectedTabs
          : observed.tabs.filter((tab) => tab.selected);
        const tabs = yield* Effect.forEach(
          selectedTabs,
          (tab) =>
            Effect.gen(function* () {
              const description = yield* describeTab(record, tab, anchored);
              const current = observed.tabs.find((candidate) => candidate.tabId === tab.tabId);
              const sameTarget =
                current &&
                JSON.stringify(current.surface) === JSON.stringify(tab.surface) &&
                JSON.stringify(current.auxiliary) === JSON.stringify(tab.auxiliary);
              if (!anchored || sameTarget) return { ...description, targetState: "present" };
              return {
                ...description,
                tabId: null,
                groupId: null,
                visible: false,
                targetState: current ? "changed" : "not_present",
              };
            }),
          { concurrency: 4 },
        );
        const changed =
          anchored &&
          (anchor.presentationRevision !== observed.presentationRevision ||
            makeWorkbenchSceneKey(selected.reference.sceneOwner) !==
              (observed.selectedSceneOwner
                ? makeWorkbenchSceneKey(observed.selectedSceneOwner)
                : null));
        return toolSuccess(
          {
            ...execution,
            presentation: {
              status: "available",
              origin: parsed.data.target
                ? "explicit"
                : anchored
                  ? "submission"
                  : anchor
                    ? "refresh"
                    : "discovered",
              reference: record.reference,
              observationId: record.observationId,
              capturedAt: record.capturedAt,
              expiresAt: record.expiresAt,
              presentationRevision: observed.presentationRevision,
              changedSinceSubmission: changed,
              selectedTabs: tabs,
              selectedTabsSource: anchored ? "submission" : "observation",
              tabCount: observed.tabs.length,
              groupCount: observed.groups.length,
            },
          },
          24 * 1024,
        );
      }
      const schema =
        input.name === "list_session_tabs"
          ? workbenchObservationSchemas.list_session_tabs
          : workbenchObservationSchemas.list_tab_groups;
      const parsed = schema.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const record = yield* observations.resolve(principal, parsed.data.observationId);
      const handle = (kind: "tab" | "group", id: string) =>
        workbenchObservationHandle(record.observationId, kind, id);
      if (input.name === "list_session_tabs") {
        const groupId =
          "groupId" in parsed.data && typeof parsed.data.groupId === "string"
            ? parsed.data.groupId
            : undefined;
        const tabs = record.observation.tabs.filter(
          (tab) =>
            (!parsed.data.panelId || tab.panelId === parsed.data.panelId) &&
            (!groupId || (tab.groupId && handle("group", tab.groupId) === groupId)),
        );
        const page = readWorkbenchObservationPage(tabs, { ...parsed.data, groupId, kind: "tabs" });
        if (!page) return toolFailure("invalid_cursor");
        const items = yield* Effect.forEach(page.items, (tab) => describeTab(record, tab), {
          concurrency: 4,
        });
        return toolSuccess({ observationId: record.observationId, ...page, items }, 24 * 1024);
      }
      const groups = record.observation.groups.filter(
        (group) => !parsed.data.panelId || group.panelId === parsed.data.panelId,
      );
      const page = readWorkbenchObservationPage(groups, { ...parsed.data, kind: "groups" });
      if (!page) return toolFailure("invalid_cursor");
      return toolSuccess(
        {
          observationId: record.observationId,
          ...page,
          items: page.items.map((group) => ({
            groupId: handle("group", group.groupId),
            panelId: group.panelId,
            focused: group.focused,
            visible: group.visible,
            tabCount: group.tabIds.length,
            selectedTabId: group.selectedTabId ? handle("tab", group.selectedTabId) : null,
          })),
        },
        24 * 1024,
      );
    });
    const result = yield* run.pipe(
      Effect.catch((error) => Effect.succeed(toolFailure(error.reason))),
    );
    return (yield* isCurrent) ? result : toolFailure("authority_unavailable");
  });
});
