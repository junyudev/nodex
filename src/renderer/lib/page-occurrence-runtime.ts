import type { IpcArgs } from "../../shared/ipc-api";
import type {
  PageOccurrenceActionInput,
  PageOccurrenceCompleteInput,
  PageOccurrenceUpdateInput,
} from "../../shared/types";
import type { DatabasePage } from "./types";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const occurrenceCommandDefinitions = {
  complete: defineRendererCommand({
    key: "page.occurrence.complete",
    channel: "page:occurrence:complete",
    authority: "core",
    owner: "PageOccurrences",
    protocol: { kind: "pending_operation" },
  }),
  skip: defineRendererCommand({
    key: "page.occurrence.skip",
    channel: "page:occurrence:skip",
    authority: "core",
    owner: "PageOccurrences",
    protocol: { kind: "pending_operation" },
  }),
  update: defineRendererCommand({
    key: "page.occurrence.update",
    channel: "page:occurrence:update",
    authority: "core",
    owner: "PageOccurrences",
    protocol: { kind: "pending_operation" },
  }),
} as const;

const {
  complete: completeOccurrenceCommand,
  skip: skipOccurrenceCommand,
  update: updateOccurrenceCommand,
} = occurrenceCommandDefinitions;

export async function readBoardPage(
  projectId: string,
  pageId: string,
  status?: DatabasePage["status"],
  minimumCommitCursor?: IpcArgs<"database-row:get">[3],
) {
  return await invokeRendererQuery(
    "database-row:get",
    projectId,
    pageId,
    status,
    minimumCommitCursor,
  );
}

export async function readCalendarOccurrenceWindow(...args: IpcArgs<"calendar:occurrences">) {
  return await invokeRendererQuery("calendar:occurrences", ...args);
}

export async function completePageOccurrence(
  projectId: string,
  input: PageOccurrenceCompleteInput,
  sessionId?: string,
) {
  return await invokePlainCommand(completeOccurrenceCommand, projectId, input, sessionId);
}

export async function skipPageOccurrence(
  projectId: string,
  input: PageOccurrenceActionInput,
  sessionId?: string,
) {
  return await invokePlainCommand(skipOccurrenceCommand, projectId, input, sessionId);
}

export async function updatePageOccurrence(
  projectId: string,
  input: PageOccurrenceUpdateInput,
  sessionId?: string,
) {
  return await invokePlainCommand(updateOccurrenceCommand, projectId, input, sessionId);
}
