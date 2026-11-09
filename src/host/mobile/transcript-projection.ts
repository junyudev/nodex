import type { HostPathFlavor } from "../host-paths";
import type { AgentSnapshot, AgentTurnItem } from "@nodex/agent-runtime/contracts";
import {
  localMarkdownImagePaths,
  rebindMarkdownImages,
} from "@nodex/agent-runtime/markdown-images";
import { replyPictureAttachmentId } from "../../shared/agent-runtime-attachments";
import {
  resolveAgentApprovalOptions,
  splitAgentApprovalOptions,
} from "../../shared/agent-approval-options";
import { getDisplayCommand } from "../../shared/codex-command-execution";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type {
  ChatActivity,
  ChatItem,
  ChatPatchOp,
  ChatRequest,
  ChatSnapshot,
  ChatStatus,
} from "@nodex/mobile-protocol";
import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";
import { attachmentRef } from "./files";

const TEXT_BYTES = 64 * 1024;
const OUTPUT_BYTES = 4 * 1024;
const WINDOW_BYTES = 256 * 1024;
export const WINDOW_ITEMS = 80;

type Activity = Extract<ChatItem, { kind: "activity" }>;
const json = (data: unknown): string | null =>
  data === undefined || data === null
    ? null
    : typeof data === "string"
      ? data
      : JSON.stringify(data);
const activityStatus = (status: string): Activity["status"] => {
  if (["running", "waiting", "pending", "inProgress", "in_progress"].includes(status))
    return "running";
  if (["cancelled", "interrupted", "declined"].includes(status)) return "declined";
  if (status === "failed") return "failed";
  return "done";
};

export const utf8Tail = (text: string, limit: number): { text: string; truncated: boolean } => {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return { text, truncated: false };
  let offset = bytes.length - limit;
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
  return { text: bytes.toString("utf8", offset), truncated: true };
};

export const chatItemId = (threadId: string, itemId: string, runId: string | null = null) =>
  Buffer.from(JSON.stringify([threadId, itemId, runId])).toString("base64url");

export const parseChatItemId = (id: string): [string, string, string | null] | null => {
  if (!/^[A-Za-z0-9_-]{1,12000}$/u.test(id)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(id, "base64url").toString());
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [thread, item, run] = value;
    if (
      typeof thread !== "string" ||
      !thread ||
      typeof item !== "string" ||
      !item ||
      (run !== null && (typeof run !== "string" || !run))
    )
      return null;
    return chatItemId(thread, item, run) === id ? [thread, item, run] : null;
  } catch {
    return null;
  }
};

export const runtimeActivity = (activity: AgentRuntimeSessionActivity): ChatActivity => ({
  sessionId: activity.sessionId,
  status: activity.pendingRequestCount > 0 ? "waiting" : activity.status,
  pendingRequestCount: activity.pendingRequestCount,
  attention: activity.approvalPrompt ?? null,
});

export const idleActivity = (sessionId: string): ChatActivity => ({
  sessionId,
  status: "idle",
  pendingRequestCount: 0,
  attention: null,
});

export const nativeActivity = (
  sessionId: string,
  status: string,
  flags: readonly string[],
): ChatActivity => {
  const pending = flags.filter(
    (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
  );
  const mapped: ChatStatus = pending.length
    ? "waiting"
    : status === "systemError"
      ? "failed"
      : status === "active"
        ? "running"
        : "idle";
  return { sessionId, status: mapped, pendingRequestCount: pending.length, attention: null };
};

/** Projects Runtime items for a host that writes paths as `hostPaths`, as its replies do. */
export const runtimeItemProjector =
  (hostPaths: HostPathFlavor) =>
  (
    sessionId: string,
    item: AgentTurnItem,
    sourceThreadId = item.threadId,
    sourceItemId = item.id,
    { queued = false, activeRunId = null }: { queued?: boolean; activeRunId?: string | null } = {},
  ): ChatItem | null => {
    // The record can keep this flag on a message its interrupted run never finished.
    const arriving = (flag: boolean) => flag && item.runId === activeRunId;
    const base = {
      id: chatItemId(sourceThreadId, sourceItemId),
      at: item.startedAt ?? item.updatedAt,
    };
    const work = (
      category: Activity["category"],
      title: string,
      detail: string | null = null,
      output: string | null = null,
      outputTruncated = false,
      images: Activity["images"] = [],
    ): Activity => ({
      ...base,
      kind: "activity",
      category,
      title,
      detail,
      output,
      outputTruncated,
      status: activityStatus(item.status),
      images,
      unavailableImages: missingCopies(item),
    });
    const notice = (text: string, tone: "info" | "warning" | "danger" = "info"): ChatItem => ({
      ...base,
      kind: "notice",
      tone,
      text,
    });
    // Every picture is named by the identities its transcript carries; the host's one attachment
    // owner reads it for the Member asking.
    const ref = (attachmentId: string) =>
      attachmentRef([sessionId, sourceThreadId, sourceItemId, attachmentId]);
    const files = (attachments: Extract<AgentTurnItem, { type: "user_message" }>["attachments"]) =>
      attachments.map((file) => ({
        ref: ref(file.id),
        name: file.name,
        mimeType: file.mimeType,
        size: file.sizeBytes,
      }));
    // A step that viewed a picture shows the copy the Agent kept, as the desktop does; any other
    // step shows the pictures its tool returned, which every Runtime read names without their bytes.
    const stepImages = (tool: DynamicTool): Activity["images"] => {
      const kept = files((tool.attachments ?? []).filter((file) => file.type === "image"));
      if (kept.length > 0) return kept.slice(0, STEP_IMAGES);
      return (tool.resultImages ?? []).slice(0, STEP_IMAGES).map(({ attachmentId, mimeType }) => ({
        ref: ref(attachmentId),
        name: "Tool output",
        mimeType,
        size: null,
      }));
    };
    switch (item.type) {
      case "user_message":
        return {
          ...base,
          kind: "user",
          text: item.text,
          files: files(item.attachments),
          unavailableImages: missingCopies(item),
          queued: queued || item.status === "pending",
        };
      case "assistant_message": {
        // An imported reply names the files it was written with: each shows the copy the Runtime
        // kept at import, read like any chat picture, or is named as missing below the reply.
        const links = item.importedImageLinks ?? [];
        const linked = new Set(links.flatMap(({ attachmentId }) => attachmentId ?? []));
        const destinations = new Map(
          links.map(({ sourcePath, attachmentId }) => [
            sourcePath,
            attachmentId === null ? null : ref(attachmentId),
          ]),
        );
        // Any other picture it shows from a file on this host is read from here, as the Member.
        for (const address of localMarkdownImagePaths(item.text, hostPaths)) {
          if (destinations.has(address)) continue;
          const picture = replyPictureAttachmentId(address);
          destinations.set(address, picture === null ? null : ref(picture));
        }
        const reply = rebindMarkdownImages(item.text, destinations);
        const images = files((item.attachments ?? []).filter(({ id }) => !linked.has(id))).filter(
          (file) => file.mimeType.startsWith("image/"),
        );
        const text = [reply, ...images.map((image) => `![](${image.ref})`)]
          .filter(Boolean)
          .join("\n\n");
        return {
          ...base,
          kind: "assistant",
          text,
          streaming: arriving(item.streaming),
          truncated: false,
          unavailableImages: missingCopies(item),
        };
      }
      case "reasoning":
        return {
          ...base,
          kind: "thinking",
          text: item.text,
          streaming: arriving(item.streaming),
          truncated: false,
        };
      case "command_execution":
        return work(
          "command",
          item.title ?? "Run command",
          item.input,
          item.output ?? null,
          item.outputOmitted,
        );
      case "file_change":
        return work(
          "file",
          item.title ?? item.fileName,
          item.fileName,
          item.diffStr ?? json(item.changes),
        );
      case "file_search":
        return work("search", "Search files", item.pattern ?? null, json(item.results));
      case "web_search":
        return work("web", "Search the web", item.patterns?.join(", ") ?? null, json(item.results));
      case "dynamic_tool":
        return work(
          "tool",
          item.title ?? item.toolName ?? "Tool",
          null,
          toolOutput(item.output ?? item.mcpToolCall?.result),
          item.outputOmitted,
          stepImages(item),
        );
      case "subagent":
        return work(
          "agent",
          item.title ?? "Delegate work",
          item.prompt,
          item.result ?? item.progress ?? null,
        );
      case "thread_created":
        return work("agent", item.title ?? "Start an agent", item.targetModel);
      case "proposed_plan":
        return work("plan", "Plan", null, item.markdown);
      case "todo_list":
        return work(
          "plan",
          "Plan",
          item.explanation ?? null,
          item.steps.map((step) => step.text).join("\n"),
        );
      case "error":
        return notice(item.failure.message, "danger");
      case "system_notice":
      case "run_interrupt_result":
        return notice(item.message);
      case "notification":
        return notice(item.summary);
      case "context_cleared":
        return notice("Context cleared");
      case "compaction":
        return notice(item.summary ?? "Context compacted");
      case "user_input_request":
        // A question still waiting is pinned above the Composer, not in the transcript.
        return item.status === "waiting"
          ? null
          : notice(item.questions.map((question) => question.question).join("\n"));
      case "secret_request":
        return notice("A secret was requested.");
      default:
        // Approvals are pinned while they wait and show as their command's outcome afterwards;
        // checkpoints, hooks and anything newer are not part of what a phone reads.
        return null;
    }
  };

export const projectNativeItem = (
  threadId: string,
  runId: string | null,
  item: ThreadItem,
): ChatItem => {
  const base = {
    id: chatItemId(threadId, item.id, runId),
    at: new Date(item.startedAtMs ?? item.completedAtMs ?? 0).toISOString(),
  };
  const work = (
    category: Activity["category"],
    title: string,
    detail: string | null,
    output: string | null,
    status = "completed",
  ): Activity => ({
    ...base,
    kind: "activity",
    category,
    title,
    detail,
    output,
    outputTruncated: false,
    status: activityStatus(status),
  });
  switch (item.type) {
    case "userMessage":
      return {
        ...base,
        kind: "user",
        text: item.content
          .flatMap((input) => (input.type === "text" ? [input.text] : []))
          .join("\n"),
        queued: false,
      };
    case "agentMessage":
    case "reasoning":
      return {
        ...base,
        kind: "thinking",
        text: [...item.summary, ...item.content].join("\n"),
        streaming: false,
        truncated: false,
      };
    case "commandExecution":
      return work("command", "Run command", item.command, item.aggregatedOutput, item.status);
    case "fileChange":
      return work("file", "Edit files", null, json(item.changes), item.status);
    case "webSearch":
      return work("web", "Search the web", item.query, null);
    case "mcpToolCall":
    case "dynamicToolCall":
    case "functionCallOutput":
    case "plan":
      return work("plan", "Plan", null, item.text);
    case "subAgentActivity":
      return work("agent", "Agent activity", item.model, null);
    case "collabAgentToolCall":
      return work("agent", item.tool, item.prompt, json(item.agentsStates), item.status);
    default:
      return work("other", "Activity", null, null);
  }
};

export const boundChatItem = (item: ChatItem): ChatItem => {
  if (item.kind === "assistant" || item.kind === "thinking") {
    const { text, truncated } = utf8Tail(item.text, TEXT_BYTES);
    return { ...item, text, truncated: item.truncated || truncated };
  }
  if (item.kind === "user" || item.kind === "notice") {
    const { text, truncated } = utf8Tail(item.text, TEXT_BYTES);
    return { ...item, text, ...(truncated ? { truncated } : {}) };
  }
  const { text, truncated } = utf8Tail(item.output ?? "", OUTPUT_BYTES);
  return {
    ...item,
    title: utf8Tail(item.title, 512).text,
    detail: item.detail === null ? null : utf8Tail(item.detail, OUTPUT_BYTES).text,
    output: item.output === null ? null : text,
    outputTruncated: item.outputTruncated || truncated,
  };
};

/** The source yields newest first. The last kept row is the exclusive anchor for older items. */
export const transcriptWindow = (
  newest: readonly { item: ChatItem; cursor: string }[],
  more: boolean,
) => {
  const items: ChatItem[] = [];
  let bytes = 0;
  let anchor: string | null = null;
  for (const row of newest) {
    const item = boundChatItem(row.item);
    const size = Buffer.byteLength(JSON.stringify(item));
    if (items.length > 0 && (items.length >= WINDOW_ITEMS || bytes + size > WINDOW_BYTES)) break;
    bytes += size;
    items.push(item);
    anchor = row.cursor;
  }
  return {
    items: items.reverse(),
    historyCursor: more || items.length < newest.length ? anchor : null,
  };
};

const serialized = (value: unknown) => JSON.stringify(value);

/** New-window eviction does not remove older items the phone can still display. */
export const chatPatch = (before: ChatSnapshot, after: ChatSnapshot): ChatPatchOp[] => {
  const prior = new Map(before.items.map((item) => [item.id, item]));
  const ops: ChatPatchOp[] = [];
  if (before.title !== after.title) ops.push({ op: "title", title: after.title });
  if (serialized(before.state) !== serialized(after.state))
    ops.push({ op: "state", state: after.state });
  for (const item of after.items) {
    const old = prior.get(item.id);
    if (serialized(old) === serialized(item)) continue;
    if (
      (item.kind === "assistant" || item.kind === "thinking") &&
      old?.kind === item.kind &&
      old.at === item.at &&
      old.streaming === item.streaming &&
      old.truncated === item.truncated &&
      item.text.startsWith(old.text) &&
      item.text.length > old.text.length
    ) {
      ops.push({
        op: "append",
        itemId: item.id,
        offset: old.text.length,
        text: item.text.slice(old.text.length),
      });
    } else {
      ops.push({ op: "upsert", item });
    }
  }
  return ops;
};

type Approval = Extract<AgentTurnItem, { type: "approval_request" }>;
export const approvalOptions = (item: Approval) => {
  const { primary, more } = splitAgentApprovalOptions(resolveAgentApprovalOptions(item.options));
  return [...primary, ...more].map((option) => ({
    id: Buffer.from(JSON.stringify([option.decision, option.optionId ?? null])).toString(
      "base64url",
    ),
    label: option.label,
    tone:
      option.decision === "accept"
        ? ("primary" as const)
        : option.decision === "decline" || option.decision === "cancel"
          ? ("danger" as const)
          : ("default" as const),
    decision: option.decision,
    optionId: option.optionId,
  }));
};

const approvalLabels: Record<Approval["requestKind"], string> = {
  command: "Command approval",
  "file-read": "File read approval",
  "file-change": "File change approval",
  permission: "Permission approval",
  "mcp-elicitation": "App access approval",
};

/** A snapshot carries its items as display rows; a control read carries none. */
export const snapshotTurnItems = (projection: AgentSnapshot["projection"]): AgentTurnItem[] => [
  ...projection.turnItems,
  ...projection.visibleTurnItems.map((row) => row.item),
];

export const projectRequests = (projection: AgentSnapshot["projection"]): ChatRequest[] => {
  const pending = new Map(
    projection.runtimeRequests
      .filter(
        (request) => request.status === "pending" && request.responseCapability.type === "live",
      )
      .map((request) => [request.id, request]),
  );
  return snapshotTurnItems(projection).flatMap((item): ChatRequest[] => {
    if (item.type === "approval_request" && pending.has(item.requestId))
      return [
        {
          kind: "approval",
          requestId: item.requestId,
          runId: item.runId,
          title: approvalLabels[item.requestKind],
          detail:
            item.requestKind === "command" && item.prompt
              ? getDisplayCommand(item.prompt)
              : (item.prompt ?? item.title ?? null),
          options: approvalOptions(item).map(({ id, label, tone }) => ({ id, label, tone })),
        },
      ];
    if (
      item.type !== "user_input_request" ||
      !pending.has(item.requestId) ||
      item.questions.some((question) => question.isSecret)
    )
      return [];
    return [
      {
        kind: "question",
        requestId: item.requestId,
        runId: item.runId,
        questions: item.questions.map((question) => ({
          id: question.id,
          prompt: question.question,
          header: question.header || null,
          multiSelect: question.multiSelect ?? false,
          options: question.options.map((option) => ({
            id: option.value ?? option.label,
            label: option.label,
            description: option.description || null,
          })),
          allowsText: question.allowCustomAnswer !== false,
        })),
      },
    ];
  });
};
