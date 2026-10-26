import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ContextHandoff,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestrationV2Subagent,
  OrchestrationV2StoredEvent,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import {
  compactDynamicToolOutput,
  omitToolOutputImageData,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "@t3tools/shared/toolOutput";

const MAX_DETAIL_STRING_BYTES = 32_768;
const MAX_DYNAMIC_VALUE_BYTES = 16_384;
const MAX_ON_DEMAND_BYTES = 256 * 1024;
const MAX_TIMELINE_TEXT_BYTES = 128 * 1024;
// Clients do not preview a larger change inline, so it is withheld whole, never cut mid-hunk.
const MAX_FILE_CHANGE_DIFF_BYTES = 256 * 1024;

function truncateDetail(
  value: string | undefined,
  maxBytes = MAX_DETAIL_STRING_BYTES,
): string | undefined {
  if (
    value === undefined ||
    (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes)
  ) {
    return value;
  }
  // UTF-8 needs at least one byte per UTF-16 code unit. Only encode the prefix
  // that could fit, rather than allocating a buffer for the complete output.
  const prefix = Buffer.from(value.slice(0, maxBytes), "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}\n… output truncated for transport`;
}

function summarizeDynamicValue(value: unknown): unknown {
  let serialized: string;
  try {
    if (typeof value === "string" && value.length > MAX_DYNAMIC_VALUE_BYTES) {
      serialized = value;
    } else {
      const json = JSON.stringify(value) ?? String(value);
      if (Buffer.byteLength(json, "utf8") <= MAX_DYNAMIC_VALUE_BYTES) {
        return value;
      }
      serialized = typeof value === "string" ? value : json;
    }
  } catch {
    serialized = "Unserializable tool output";
  }

  // Preserve the first nonblank normalized line, but stop after the preview.
  // Splitting and normalizing every line can allocate far more than the input.
  const start = /\S/u.exec(serialized)?.index;
  let firstLine = start === undefined ? "Large tool output" : "";
  let pendingSpace = false;
  for (let index = start ?? serialized.length; index < serialized.length; index += 1) {
    const character = serialized[index]!;
    if (character === "\n") break;
    if (/\s/u.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) firstLine += " ";
    firstLine += character;
    pendingSpace = false;
    if (firstLine.length > 160) break;
  }
  return {
    summary: firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 159).trimEnd()}…`,
    truncated: true,
  };
}

type McpToolCall = NonNullable<
  Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>["mcpToolCall"]
>;
type McpJson = McpToolCall["arguments"];

/** Unknown protocol extensions are retained when small, never an unbounded history body. */
function mcpCallMetadata(call: McpToolCall) {
  const { arguments: _arguments, result: _result, ...metadata } = call;
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") <= MAX_DYNAMIC_VALUE_BYTES)
    return metadata;
  return {
    type: call.type,
    id: call.id,
    server: call.server,
    tool: call.tool,
    status: call.status,
    ...(call.error == null ? {} : { error: { message: truncateDetail(call.error.message) ?? "" } }),
    transportMetadataTruncated: true,
  };
}

function projectMcpCallForWire(call: McpToolCall): McpToolCall {
  const result = call.result;
  return {
    ...mcpCallMetadata(call),
    arguments: summarizeDynamicValue(call.arguments) as McpJson,
    ...(result == null
      ? result === undefined
        ? {}
        : { result }
      : {
          result: {
            content: [],
            ...(result._meta === undefined
              ? {}
              : { _meta: summarizeDynamicValue(result._meta) as McpJson }),
          },
        }),
  };
}

function isMcpJsonRecord(value: McpJson): value is { readonly [key: string]: McpJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keep original content positions, so an image descriptor resolves the exact recorded block. */
function boundIndexedToolContent(blocks: ReadonlyArray<McpJson>): McpJson[] {
  let remainingBytes = MAX_ON_DEMAND_BYTES;
  const content = blocks.slice(0, 1024).map((block): McpJson => {
    if (
      isMcpJsonRecord(block) &&
      block.type === "inputImage" &&
      typeof block.imageUrl === "string" &&
      /^data:image\//iu.test(block.imageUrl)
    )
      return { type: "inputImage" };
    if (isMcpJsonRecord(block) && block.type === "image") {
      const { data: _data, ...marker } = block;
      const size = Buffer.byteLength(JSON.stringify(marker), "utf8");
      if (size > Math.min(remainingBytes, MAX_DYNAMIC_VALUE_BYTES))
        return {
          type: "image",
          ...(typeof block.mimeType === "string"
            ? { mimeType: truncateDetail(block.mimeType, 256)! }
            : {}),
        };
      remainingBytes -= size;
      return marker;
    }
    const serialized = JSON.stringify(block);
    const size = Buffer.byteLength(serialized, "utf8");
    if (size <= remainingBytes) {
      remainingBytes -= size;
      return block;
    }
    const text = isMcpJsonRecord(block) && typeof block.text === "string" ? block.text : serialized;
    const truncated = truncateDetail(text, remainingBytes) ?? "";
    remainingBytes = 0;
    return { type: "text", text: truncated };
  });
  if (content.length !== blocks.length)
    content.push({ type: "text", text: "… output truncated for transport" });
  return content;
}

function projectMcpCallForDetail(call: McpToolCall): McpToolCall {
  const result = call.result;
  if (result == null)
    return {
      ...mcpCallMetadata(call),
      arguments: boundDynamicValue(call.arguments) as McpJson,
      ...(result === undefined ? {} : { result }),
    };
  const content = boundIndexedToolContent(result.content);
  const { content: _content, structuredContent: _structured, _meta: _meta, ...extensions } = result;
  return {
    ...mcpCallMetadata(call),
    arguments: boundDynamicValue(call.arguments) as McpJson,
    result: {
      ...(summarizeDynamicValue(extensions) as { readonly [key: string]: McpJson }),
      content,
      ...(result._meta === undefined
        ? {}
        : { _meta: summarizeDynamicValue(result._meta) as McpJson }),
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: boundDynamicValue(result.structuredContent) as McpJson }),
    },
  };
}

/** Each file keeps its diff while the item's budget lasts; a withheld diff keeps its counts. */
function projectFileChangesForWire(
  changes: NonNullable<Extract<OrchestrationV2TurnItem, { type: "file_change" }>["changes"]>,
) {
  let remaining = MAX_FILE_CHANGE_DIFF_BYTES;
  return changes.map((change) => {
    if (change.diff === undefined) return change;
    // UTF-8 needs at least one byte per code unit, so a longer string cannot fit.
    const bytes = change.diff.length > remaining ? null : Buffer.byteLength(change.diff, "utf8");
    if (bytes === null || bytes > remaining) {
      const { diff: _diff, ...withheld } = change;
      return withheld;
    }
    remaining -= bytes;
    return change;
  });
}

export function projectTurnItemForWire(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return { ...item, text: truncateDetail(item.text, MAX_TIMELINE_TEXT_BYTES) ?? "" };
    case "proposed_plan":
      return { ...item, markdown: truncateDetail(item.markdown, MAX_TIMELINE_TEXT_BYTES) ?? "" };
    case "handoff": {
      const { summary: _summary, ...projected } = item;
      return projected;
    }
    case "command_execution": {
      const { output, ...projected } = item;
      // Clients used this preview to recognize provider-reported failures. Keep
      // the outcome without retaining or serializing the output that proved it.
      const failed =
        item.outputIndicatesFailure === true ||
        (item.exitCode !== undefined && item.exitCode !== 0) ||
        (output !== undefined &&
          toolOutputIndicatesFailure(output.slice(0, MAX_DETAIL_STRING_BYTES)));
      return {
        ...projected,
        input: truncateDetail(item.input) ?? "",
        ...(failed ? { outputIndicatesFailure: true } : {}),
        ...(output?.trim() ? { outputOmitted: true } : {}),
      };
    }
    case "file_change": {
      // Diffs are the change itself, so they travel with the timeline like message text.
      const { diffStr, changes, ...projected } = item;
      return {
        ...projected,
        ...(changes === undefined ? {} : { changes: projectFileChangesForWire(changes) }),
        // A failed edit stores the provider's error where the diff would be.
        ...(item.status === "failed" && diffStr?.trim()
          ? { diffStr: truncateDetail(diffStr) }
          : {}),
      };
    }
    case "subagent": {
      const { progress: _progress, ...metadata } = item;
      return { ...metadata, prompt: "", result: null };
    }
    case "dynamic_tool": {
      const { output: rawOutput, mcpToolCall, ...projected } = item;
      const output = compactDynamicToolOutput(rawOutput);
      return {
        ...projected,
        input: summarizeDynamicValue(item.input),
        ...(output === undefined ? {} : { output }),
        ...(mcpToolCall === undefined ? {} : { mcpToolCall: projectMcpCallForWire(mcpToolCall) }),
        ...(hasDynamicValue(rawOutput) ||
        hasDynamicValue(mcpToolCall?.result?.content) ||
        hasDynamicValue(mcpToolCall?.result?.structuredContent)
          ? { outputOmitted: true }
          : {}),
      };
    }
    default:
      return item;
  }
}

function hasDynamicValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

function boundDynamicValue(value: unknown): unknown {
  if (value === undefined) return value;
  if (typeof value === "string") return truncateDetail(value, MAX_ON_DEMAND_BYTES);
  let json: string;
  try {
    // Compact, so measuring does not inflate the value; clients indent it.
    json = JSON.stringify(value) ?? String(value);
  } catch {
    return "Unserializable tool value";
  }
  return Buffer.byteLength(json, "utf8") <= MAX_ON_DEMAND_BYTES
    ? value
    : truncateDetail(json, MAX_ON_DEMAND_BYTES);
}

/**
 * A tool output for a detail read, without image bytes. When the rest is too
 * large to send whole, its truncated text still comes with the image markers,
 * in order, so clients can load each image by index.
 */
function boundToolOutput(output: unknown): unknown {
  if (Array.isArray(output) && output.some((block) => block?.type === "inputImage")) {
    return boundIndexedToolContent(output);
  }
  const omitted = omitToolOutputImageData(output);
  const bounded = boundDynamicValue(omitted);
  if (typeof bounded !== "string" || typeof omitted === "string") return bounded;
  const images = toolOutputImages(omitted);
  return images.length === 0
    ? bounded
    : [
        { type: "text", text: bounded },
        ...images.map((image) => ({ type: "image", mimeType: image.mimeType })),
      ];
}

/**
 * Projects one item for an on-demand detail read: keeps the input and output
 * the timeline withholds, bounded so a huge result cannot stall the socket.
 * Image bytes are left out; clients load them as `tool-output-image` assets.
 */
export function projectTurnItemForDetail(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return { ...item, text: truncateDetail(item.text, MAX_ON_DEMAND_BYTES) ?? "" };
    case "proposed_plan":
      return { ...item, markdown: truncateDetail(item.markdown, MAX_ON_DEMAND_BYTES) ?? "" };
    case "command_execution":
      return {
        ...item,
        input: truncateDetail(item.input, MAX_ON_DEMAND_BYTES) ?? "",
        output: truncateDetail(item.output, MAX_ON_DEMAND_BYTES),
      };
    case "dynamic_tool":
      return {
        ...item,
        input: boundDynamicValue(item.input),
        output: boundToolOutput(item.output),
        ...(item.mcpToolCall === undefined
          ? {}
          : { mcpToolCall: projectMcpCallForDetail(item.mcpToolCall) }),
      };
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt, MAX_ON_DEMAND_BYTES) ?? "",
        progress: truncateDetail(item.progress, MAX_ON_DEMAND_BYTES),
        result:
          item.result === null ? null : (truncateDetail(item.result, MAX_ON_DEMAND_BYTES) ?? null),
      };
    case "handoff":
    case "file_change":
      return projectTurnItemForWire(item);
    default:
      return item;
  }
}

export function projectContextHandoffForWire(
  handoff: OrchestrationV2ContextHandoff,
): OrchestrationV2ContextHandoff {
  const { history: _history, delivery: _delivery, ...projected } = handoff;
  return { ...projected, summaryText: "" };
}

/** Task bodies and delivery state belong to execution and explicit detail reads. */
export function projectSubagentForWire(task: OrchestrationV2Subagent): OrchestrationV2Subagent {
  const {
    progress: _progress,
    workflow: _workflow,
    completionDelivery: _delivery,
    ...metadata
  } = task;
  return {
    ...metadata,
    prompt: "",
    result: null,
    title: truncateDetail(task.title ?? undefined, 512) ?? null,
    model: truncateDetail(task.model ?? undefined, 256) ?? null,
    ...(task.modelSelection === undefined
      ? {}
      : {
          modelSelection: {
            instanceId: task.modelSelection.instanceId,
            model: task.modelSelection.model,
          },
        }),
  };
}

function projectRunForWire(run: OrchestrationV2Run): OrchestrationV2Run {
  const {
    delegatedCompletion: _completion,
    restartCancelledBackgroundWork: _work,
    ...metadata
  } = run;
  return metadata;
}

export function projectThreadProjectionForWire(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const projectedById = new Map<string, OrchestrationV2TurnItem>();
  const project = (item: OrchestrationV2TurnItem) => {
    const key = `${item.threadId}:${item.id}`;
    const existing = projectedById.get(key);
    if (existing !== undefined) return existing;
    const projected = projectTurnItemForWire(item);
    projectedById.set(key, projected);
    return projected;
  };
  return {
    ...projection,
    runs: projection.runs.map(projectRunForWire),
    messages: projection.messages.map((message) => ({
      ...message,
      text: truncateDetail(message.text, MAX_TIMELINE_TEXT_BYTES) ?? "",
    })),
    plans: projection.plans.map((plan) =>
      plan.kind === "proposed_plan"
        ? { ...plan, markdown: truncateDetail(plan.markdown, MAX_TIMELINE_TEXT_BYTES) ?? "" }
        : { ...plan, explanation: truncateDetail(plan.explanation) },
    ),
    subagents: projection.subagents.map(projectSubagentForWire),
    contextHandoffs: projection.contextHandoffs.map(projectContextHandoffForWire),
    turnItems: projection.turnItems.map(project),
    visibleTurnItems: projection.visibleTurnItems.map((row) => ({
      ...row,
      item: project(row.item),
    })),
  };
}

export function projectDomainEventForWire(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent {
  return event.type === "turn-item.updated"
    ? { ...event, payload: projectTurnItemForWire(event.payload) }
    : event.type === "message.updated"
      ? {
          ...event,
          payload: {
            ...event.payload,
            text: truncateDetail(event.payload.text, MAX_TIMELINE_TEXT_BYTES) ?? "",
          },
        }
      : event.type === "run.created" || event.type === "run.updated"
        ? { ...event, payload: projectRunForWire(event.payload) }
        : event.type === "subagent.updated"
          ? { ...event, payload: projectSubagentForWire(event.payload) }
          : event.type === "context-handoff.updated"
            ? { ...event, payload: projectContextHandoffForWire(event.payload) }
            : event;
}

/** Projection precedes codec traversal, so discarded bodies never enter a frame. */
export function projectStoredEventForWire(
  event: OrchestrationV2StoredEvent,
): OrchestrationV2StoredEvent {
  const projected = { ...event, event: projectDomainEventForWire(event.event) };
  return assertPublicWirePayloadBudget(projected);
}

export function assertPublicWirePayloadBudget<A>(value: A): A {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1_048_576)
    throw new Error("The payload exceeds the public stream transport budget.");
  return value;
}
