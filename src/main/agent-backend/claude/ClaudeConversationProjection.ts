import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentCanonicalSessionUpdate,
  AgentConversationActor,
  AgentConversationSnapshot,
  AgentConversationTask,
} from "../../../shared/agent-conversation";
import { isAgentConversationTaskLiveInSnapshot } from "../../../shared/agent-conversation";
import {
  beginAgentConversationTurn,
  boundAgentConversationTurns,
  reduceAgentConversationEvent,
} from "../AgentConversationProjection";
import {
  CLAUDE_EVENT_DISPOSITIONS,
  CLAUDE_SYSTEM_EVENT_DISPOSITIONS,
  claudeNumber,
  claudeRecord,
  claudeText,
  claudeTokenUsage,
} from "./ClaudeEventHelpers";
import { claudeHistoryPromptText, isClaudeHistoryPrompt } from "../../../shared/claude-history";

type ToolUpdate = Extract<AgentCanonicalSessionUpdate, { kind: "tool-call" }>;
type Block = {
  readonly index: number;
  readonly type: string;
  readonly key: string;
  readonly toolId?: string;
  readonly recordIds: readonly string[];
  readonly inputJson?: string;
};
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const json = (value: unknown): string => JSON.stringify(value)?.slice(0, 65536) ?? "";
const blocksOf = (body: unknown): readonly Readonly<Record<string, unknown>>[] => {
  const content = claudeRecord(body).content;
  return Array.isArray(content)
    ? content.map(claudeRecord)
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];
};
const classifyTool = (name: string): Pick<ToolUpdate, "toolKind" | "presentation"> => {
  if (name === "Read") return { toolKind: "read", presentation: "generic" };
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name))
    return { toolKind: "edit", presentation: "file-change" };
  if (name === "Bash") return { toolKind: "execute", presentation: "command" };
  if (name === "Glob" || name === "Grep") return { toolKind: "search", presentation: "search" };
  if (name === "WebSearch" || name === "web_search")
    return { toolKind: "fetch", presentation: "web-search" };
  if (name === "WebFetch" || name === "web_fetch")
    return { toolKind: "fetch", presentation: "generic" };
  if (name === "EnterPlanMode" || name === "ExitPlanMode")
    return { toolKind: "switch_mode", presentation: "generic" };
  return { toolKind: "other", presentation: name.startsWith("mcp__") ? "mcp" : "generic" };
};
const tool = (id: string, name: string, actor?: AgentConversationActor): ToolUpdate => ({
  kind: "tool-call",
  key: `tool:${id}`,
  toolCallId: id,
  title: name,
  name,
  ...classifyTool(name),
  status: "in_progress",
  detail: "",
  locations: [],
  ...(actor ? { actor } : {}),
});
const update = (
  snapshot: AgentConversationSnapshot,
  sequence: number | null,
  value: AgentCanonicalSessionUpdate,
  append = false,
) =>
  reduceAgentConversationEvent(snapshot, {
    kind: "session_update",
    turnSequence: sequence,
    update: value,
    append,
  });
const previousTool = (snapshot: AgentConversationSnapshot, id: string) =>
  snapshot.toolCalls?.find((entry) => entry.update.toolCallId === id) ??
  snapshot.turns
    .flatMap((turn) =>
      turn.updates.flatMap((entry) =>
        entry.kind === "tool-call" && entry.toolCallId === id
          ? [{ turnSequence: turn.sequence, update: entry }]
          : [],
      ),
    )
    .at(-1);

const registryBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const boundToolRegistry = (entries: NonNullable<AgentConversationSnapshot["toolCalls"]>) => {
  let completed = entries
    .filter((entry) => entry.update.status !== "pending" && entry.update.status !== "in_progress")
    .slice(-512);
  let active = entries.filter(
    (entry) => entry.update.status === "pending" || entry.update.status === "in_progress",
  );
  while (completed.length && registryBytes([...completed, ...active]) > 192 * 1024)
    completed = completed.slice(1);
  if (registryBytes(active) > 192 * 1024)
    active = active.map((entry) => ({
      ...entry,
      update: {
        ...entry.update,
        input: entry.update.input?.slice(0, 1024),
        detail: entry.update.detail.slice(0, 1024),
        output: undefined,
        resources: undefined,
        changes: undefined,
        truncated: true,
      },
    }));
  return [...completed, ...active];
};

/** Tool state is independent of the bounded transcript, and updates always target its birth turn. */
const upsertTool = (
  snapshot: AgentConversationSnapshot,
  sequence: number | null,
  incoming: ToolUpdate,
): AgentConversationSnapshot => {
  const existing = previousTool(snapshot, incoming.toolCallId);
  const value = { ...existing?.update, ...incoming };
  const born = existing?.turnSequence ?? sequence;
  const entries = (snapshot.toolCalls ?? []).filter(
    (entry) => entry.update.toolCallId !== incoming.toolCallId,
  );
  const next = {
    ...snapshot,
    toolCalls: boundToolRegistry([...entries, { turnSequence: born, update: value }]),
  };
  // A pruned turn stays pruned; the session registry still receives the terminal state.
  return snapshot.turns.some((turn) => turn.sequence === born) || born === sequence
    ? update(next, born, value)
    : next;
};
const resources = (value: unknown): NonNullable<ToolUpdate["resources"]> =>
  Array.isArray(value)
    ? value
        .flatMap((part) => {
          const link = claudeRecord(part);
          const uri = string(link.uri);
          return uri ? [{ uri, name: string(link.name), mimeType: string(link.mimeType) }] : [];
        })
        .slice(0, 50)
    : [];

const promptImages = (nativeMessageId: string | undefined, message: unknown) =>
  nativeMessageId
    ? blocksOf(message)
        .flatMap((part, index) => {
          if (part.type !== "image") return [];
          const source = claudeRecord(part.source);
          return [
            {
              nativeMessageId,
              index,
              mediaType: string(source.media_type)?.slice(0, 128) ?? "image",
            },
          ];
        })
        .slice(0, 32)
    : [];

export const claudeAcceptedInputKey = (messageId: string): string => `input:${messageId}`;
interface ClaudeAcceptedInput {
  readonly messageId: string;
  readonly text: string;
  readonly images?: readonly import("../../../shared/agent-history-images").AgentPromptImageDescriptor[];
}

/** Accepted steering stays visible before the native echo and keeps one exact user record. */
export const projectClaudeAcceptedInput = (
  snapshot: AgentConversationSnapshot,
  sequence: number,
  input: ClaudeAcceptedInput,
): AgentConversationSnapshot =>
  update(snapshot, sequence, {
    kind: "message",
    key: claudeAcceptedInputKey(input.messageId),
    messageId: input.messageId,
    role: "user",
    text: input.text || (input.images?.length ? "[Image]" : ""),
  });

/** A queued batch moves its user records to the native Turn that actually consumes it. */
export const beginClaudeAcceptedInputTurn = (
  snapshot: AgentConversationSnapshot,
  sequence: number,
  inputs: readonly ClaudeAcceptedInput[],
): AgentConversationSnapshot => {
  const primary = inputs[0];
  if (!primary) return snapshot;
  const keys = new Set(inputs.map((input) => claudeAcceptedInputKey(input.messageId)));
  const acknowledged = new Map(
    snapshot.turns
      .flatMap((turn) => turn.updates)
      .filter((value) => value.kind === "message" && keys.has(value.key))
      .map((value) => [value.key, value] as const),
  );
  const primaryRecord = acknowledged.get(claudeAcceptedInputKey(primary.messageId));
  let next = beginAgentConversationTurn(
    {
      ...snapshot,
      turns: snapshot.turns.map((turn) => ({
        ...turn,
        updates: turn.updates.filter((value) => !keys.has(value.key)),
      })),
    },
    sequence,
    primary.text || (primary.images?.length ? "[Image]" : ""),
    primary.messageId,
  );
  if (primaryRecord?.kind === "message")
    next = {
      ...next,
      turns: next.turns.map((turn) =>
        turn.sequence === sequence
          ? {
              ...turn,
              promptImages: primaryRecord.promptImages,
              ...(primaryRecord.recordIds?.includes(primary.messageId)
                ? { nativeUserMessageId: primary.messageId }
                : {}),
            }
          : turn,
      ),
    };
  for (const input of inputs.slice(1)) {
    const record = acknowledged.get(claudeAcceptedInputKey(input.messageId));
    next = record
      ? update(next, sequence, record)
      : projectClaudeAcceptedInput(next, sequence, input);
  }
  return next;
};

const locations = (input: unknown): string[] => {
  const data = claudeRecord(input);
  return [data.file_path, data.notebook_path, data.path].filter(
    (value): value is string => typeof value === "string",
  );
};

/** Native media stays in its native history; transport snapshots carry a readable descriptor. */
const boundedMediaContent = (content: unknown): unknown => {
  if (!Array.isArray(content)) return content;
  return content.slice(0, 128).map((value) => {
    const part = claudeRecord(value);
    if (part.type !== "image" && part.type !== "document") return value;
    const mime = string(part.mimeType ?? claudeRecord(part.source).media_type) ?? part.type;
    const title = string(part.title);
    return {
      type: "text",
      text: `[${part.type === "image" ? "Image" : "Document"} · ${title ?? mime}]`,
    };
  });
};
const boundedNativeToolOutput = (value: unknown, name: string | null): unknown => {
  if (Array.isArray(value)) return boundedMediaContent(value);
  const output = claudeRecord(value);
  if (output.type === "image" && name === "Read")
    return { ...output, file: { ...claudeRecord(output.file), base64: undefined } };
  if (Array.isArray(output.content))
    return { ...output, content: boundedMediaContent(output.content) };
  return value;
};
const fileChanges = (
  name: string | null,
  input: unknown,
  output: unknown,
): ToolUpdate["changes"] => {
  if (!name || !["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)) return undefined;
  const data = claudeRecord(input);
  const result = claudeRecord(output);
  const path = string(result.filePath ?? result.file_path ?? data.file_path ?? data.notebook_path);
  if (!path) return undefined;
  const patches = result.structuredPatch;
  const patchDiff = Array.isArray(patches)
    ? patches
        .map((part) => {
          const patch = claudeRecord(part);
          return `@@ -${claudeNumber(patch.oldStart)},${claudeNumber(patch.oldLines)} +${claudeNumber(patch.newStart)},${claudeNumber(patch.newLines)} @@\n${Array.isArray(patch.lines) ? patch.lines.filter((line): line is string => typeof line === "string").join("\n") : ""}`;
        })
        .join("\n")
    : undefined;
  if (name === "Write") {
    const added = result.type === "create";
    const diff = added ? claudeText(data.content) : patchDiff;
    return [{ path, kind: added ? "add" : "update", diff }];
  }
  const diff = patchDiff ?? `-${claudeText(data.old_string)}\n+${claudeText(data.new_string)}`;
  return [{ path, kind: "update", diff }];
};

const projectPlanResult = (
  snapshot: AgentConversationSnapshot,
  sequence: number | null,
  call: ToolUpdate,
  input: unknown,
  output: unknown,
): AgentConversationSnapshot => {
  if (call.actor || call.status !== "completed") return snapshot;
  const data = claudeRecord(input);
  const result = claudeRecord(output);
  if (call.name === "TodoWrite" && Array.isArray(data.todos))
    return update(snapshot, sequence, {
      kind: "plan",
      key: "plan:todos",
      planId: "todos",
      state: "present",
      markdown: null,
      uri: null,
      entries: data.todos.flatMap((value) => {
        const todo = claudeRecord(value);
        if (typeof todo.content !== "string") return [];
        return [
          {
            content: todo.content,
            priority:
              todo.priority === "high" || todo.priority === "low" ? todo.priority : "medium",
            status:
              todo.status === "completed" || todo.status === "in_progress"
                ? todo.status
                : "pending",
          },
        ];
      }),
    });
  if (!["TaskCreate", "TaskUpdate", "TaskGet", "TaskList"].includes(call.name ?? ""))
    return snapshot;
  const current = snapshot.turns
    .flatMap((turn) => turn.updates)
    .findLast((value) => value.kind === "plan" && value.key === "plan:tasks");
  const entries = [...(current?.kind === "plan" ? current.entries : [])];
  const tasks =
    call.name === "TaskList" && Array.isArray(result.tasks)
      ? result.tasks
      : [
          result.task ?? {
            id: result.taskId ?? data.taskId,
            subject: data.subject,
            status: claudeRecord(result.statusChange).to ?? data.status,
          },
        ];
  if (result.success === false) return snapshot;
  for (const value of tasks) {
    const task = claudeRecord(value);
    const id = string(task.id);
    if (!id) continue;
    const index = entries.findIndex((entry) => entry.content.startsWith(`[${id}] `));
    const subject = string(task.subject) ?? entries[index]?.content.slice(id.length + 3);
    if (!subject) continue;
    const status: "completed" | "in_progress" | "pending" =
      task.status === "completed"
        ? "completed"
        : task.status === "in_progress"
          ? "in_progress"
          : "pending";
    const entry = { content: `[${id}] ${subject}`, priority: "medium" as const, status };
    if (task.status === "deleted") {
      if (index >= 0) entries.splice(index, 1);
      continue;
    }
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
  }
  return update(snapshot, sequence, {
    kind: "plan",
    key: "plan:tasks",
    planId: "tasks",
    state: "present",
    entries,
    markdown: null,
    uri: null,
  });
};

/** Per-actor stream state joins SDK block snapshots without assuming their array index is an API block index. */
export const createClaudeMessageProjection = () => {
  const streamIds = new Map<string, string>();
  const messageBlocks = new Map<string, Block[]>();
  const seenRecords = new Set<string>();
  const toolVersions = new Map<
    string,
    { readonly uuid: string; readonly turnSequence: number | null; readonly update: ToolUpdate }[]
  >();
  let contextTokens = 0;
  let mainModel: string | undefined;
  let currentUsage = claudeTokenUsage({});
  let contextOutputTokens = 0;
  const rememberTool = (snapshot: AgentConversationSnapshot, id: string, uuid?: string) => {
    if (!uuid) return;
    const current = previousTool(snapshot, id);
    if (!current) return;
    toolVersions.set(
      id,
      [
        ...(toolVersions.get(id) ?? []).filter((version) => version.uuid !== uuid),
        { uuid, ...current },
      ].slice(-4),
    );
    if (toolVersions.size > 512) toolVersions.delete(toolVersions.keys().next().value!);
    while (toolVersions.size > 1 && registryBytes([...toolVersions.values()]) > 512 * 1024)
      toolVersions.delete(toolVersions.keys().next().value!);
  };
  const actorFor = (
    snapshot: AgentConversationSnapshot,
    parent?: string | null,
    agentId?: string,
  ): AgentConversationActor | undefined => {
    if (!parent && !agentId) return undefined;
    const task = snapshot.tasks?.find(
      (entry) =>
        (parent !== undefined &&
          parent !== null &&
          (entry.toolUseId === parent || entry.id === parent || entry.agentId === parent)) ||
        (agentId !== undefined && entry.agentId === agentId),
    );
    return {
      ...(parent ? { parentToolUseId: parent } : {}),
      ...(agentId ? { agentId } : {}),
      ...(task ? { taskId: task.id, agentId: task.agentId ?? agentId } : {}),
    };
  };
  const identityFor = (parent: string | null | undefined, id: string) =>
    `${parent ?? "root"}:${id}`;
  const projectBlock = (
    snapshot: AgentConversationSnapshot,
    sequence: number | null,
    part: Readonly<Record<string, unknown>>,
    block: Block,
    actor: AgentConversationActor | undefined,
    recordId?: string,
    append = false,
    assistant = true,
  ): AgentConversationSnapshot => {
    const recordIds = [...new Set([...block.recordIds, ...(recordId ? [recordId] : [])])];
    const common = { ...(actor ? { actor } : {}), recordIds };
    if (part.type === "text" || part.type === "thinking" || part.type === "redacted_thinking")
      return update(
        snapshot,
        sequence,
        {
          kind: "message",
          key: block.key,
          messageId: block.key,
          role: part.type === "text" ? (assistant ? "agent" : "user") : "thought",
          text: part.type === "redacted_thinking" ? "" : claudeText(part.text ?? part.thinking),
          truncated:
            typeof (part.text ?? part.thinking) === "string" &&
            String(part.text ?? part.thinking).length > 65536,
          ...common,
        },
        append,
      );
    if (part.type === "image")
      return update(snapshot, sequence, {
        kind: "message",
        key: block.key,
        messageId: block.key,
        role: assistant ? "agent" : "user",
        text: `[Image · ${string(claudeRecord(part.source).media_type) ?? "image"}]`,
        ...common,
      });
    if (part.type === "document" || part.type === "search_result" || part.type === "resource_link")
      return update(snapshot, sequence, {
        kind: "message",
        key: block.key,
        messageId: block.key,
        role: assistant ? "agent" : "user",
        text:
          part.type === "search_result"
            ? claudeText(part.content)
            : `[${part.type === "document" ? "Document" : "Resource"} · ${string(part.title ?? part.name) ?? "attachment"}]`,
        ...common,
      });
    if (
      (part.type === "tool_use" ||
        part.type === "server_tool_use" ||
        part.type === "mcp_tool_use") &&
      typeof part.id === "string" &&
      typeof part.name === "string"
    ) {
      const previous = previousTool(snapshot, part.id)?.update;
      const input = part.input;
      const name =
        part.type === "mcp_tool_use" && typeof part.server_name === "string"
          ? `mcp__${part.server_name}__${part.name}`
          : part.name;
      let next = upsertTool(snapshot, sequence, {
        ...tool(part.id, name, actor),
        ...previous,
        input: json(input),
        locations: locations(input),
        ...common,
        recordIds: [...new Set([...(previous?.recordIds ?? []), ...recordIds])],
      });
      rememberTool(next, part.id, recordId);
      if (part.name === "ExitPlanMode" && typeof claudeRecord(input).plan === "string")
        next = update(next, sequence, {
          kind: "plan",
          key: `plan:${part.id}`,
          planId: part.id,
          state: "present",
          entries: [],
          markdown: claudeText(claudeRecord(input).plan),
          uri: null,
          ...common,
        });
      return next;
    }
    if (typeof part.tool_use_id !== "string" || !part.type?.toString().includes("result"))
      return snapshot;
    const previous = previousTool(snapshot, part.tool_use_id);
    const content = boundedMediaContent(part.content);
    const nativeOutput = part.nativeOutput ?? content;
    const output = boundedNativeToolOutput(nativeOutput, previous?.update.name ?? null);
    let input: unknown;
    try {
      input = JSON.parse(previous?.update.input ?? "{}");
    } catch {
      input = {};
    }
    const links = resources(
      claudeRecord(output).resourceLinks ??
        (Array.isArray(content)
          ? content.filter((entry) => claudeRecord(entry).type === "resource_link")
          : undefined),
    );
    const value: ToolUpdate = {
      ...(previous?.update ?? tool(part.tool_use_id, "Tool", actor)),
      status: part.is_error || claudeRecord(output).isError === true ? "failed" : "completed",
      detail: claudeText(content),
      truncated:
        typeof content === "string"
          ? content.length > 65536
          : Array.isArray(content) &&
            content.reduce(
              (sum, block) =>
                sum +
                (typeof claudeRecord(block).text === "string"
                  ? String(claudeRecord(block).text).length
                  : 0),
              0,
            ) > 65536,
      output,
      outputRecordId: recordId ?? previous?.update.outputRecordId,
      resources: links,
      recordIds: [...new Set([...(previous?.update.recordIds ?? []), ...recordIds])],
      changes: fileChanges(previous?.update.name ?? null, input, output),
    };
    let next = upsertTool(snapshot, sequence, value);
    rememberTool(next, part.tool_use_id, recordId);
    next = projectPlanResult(next, previous?.turnSequence ?? sequence, value, input, output);
    return next;
  };
  const projectContent = (
    snapshot: AgentConversationSnapshot,
    body: unknown,
    uuid: string,
    sequence: number | null,
    parent?: string | null,
    nativeOutput?: unknown,
    agentId?: string,
    assistant = true,
  ) => {
    const parts = blocksOf(body);
    const id = string(claudeRecord(body).id) ?? uuid;
    const identity = identityFor(parent ?? agentId, id);
    const existing = messageBlocks.get(identity) ?? [];
    const actor = actorFor(snapshot, parent, agentId);
    let next = snapshot;
    for (const [position, part] of parts.entries()) {
      const type = string(part.type) ?? "unknown";
      const toolId = string(part.id ?? part.tool_use_id);
      const matched = toolId
        ? existing.find((entry) => entry.toolId === toolId)
        : parts.length > 1
          ? existing.find((entry) => entry.index === position && entry.type === type)
          : existing.find((entry) => entry.type === type && entry.recordIds.length === 0);
      const index =
        matched?.index ??
        (parts.length > 1 ? position : Math.max(-1, ...existing.map((entry) => entry.index)) + 1);
      const key = toolId
        ? `tool:${toolId}`
        : `message:${(parent ?? agentId) ? `${parent ?? agentId}:` : ""}${id}:${index}`;
      const block: Block = {
        ...(matched ?? { index, type, key, toolId, recordIds: [] }),
        recordIds: [...new Set([...(matched?.recordIds ?? []), uuid])],
      };
      const selected = existing.findIndex((entry) => entry.index === block.index);
      if (selected < 0) existing.push(block);
      else existing[selected] = block;
      next = projectBlock(
        next,
        sequence,
        nativeOutput === undefined ? part : { ...part, nativeOutput },
        block,
        actor,
        uuid,
        false,
        assistant,
      );
    }
    messageBlocks.set(identity, existing);
    if (messageBlocks.size > 512) messageBlocks.delete(messageBlocks.keys().next().value!);
    return next;
  };
  const diagnostic = (
    snapshot: AgentConversationSnapshot,
    sequence: number | null,
    code: string,
    message: string,
    severity: "info" | "warning" | "error" = "info",
    details?: Readonly<Record<string, unknown>>,
  ) =>
    update(snapshot, sequence, {
      kind: "diagnostic",
      key: `diagnostic:${code}`,
      code,
      severity,
      message: message.slice(0, 8192),
      details,
    });
  const projectTask = (
    snapshot: AgentConversationSnapshot,
    sequence: number | null,
    message: Readonly<Record<string, unknown>>,
  ) => {
    const id = string(message.task_id);
    if (!id) return snapshot;
    const patch = message.subtype === "task_updated" ? claudeRecord(message.patch) : message;
    const existing = snapshot.tasks?.find((task) => task.id === id);
    const parent = previousTool(snapshot, string(message.tool_use_id) ?? existing?.toolUseId ?? "");
    const rawStatus = string(patch.status);
    const status: AgentConversationTask["status"] =
      rawStatus === "stopped" || rawStatus === "killed"
        ? "cancelled"
        : rawStatus === "completed" ||
            rawStatus === "failed" ||
            rawStatus === "pending" ||
            rawStatus === "running" ||
            rawStatus === "paused"
          ? rawStatus
          : existing
            ? existing.status
            : "running";
    let parentInput: Readonly<Record<string, unknown>> = {};
    try {
      parentInput = claudeRecord(JSON.parse(parent?.update.input ?? "{}"));
    } catch {
      /* Input can still be streaming. */
    }
    const usage = claudeRecord(message.usage);
    const task: AgentConversationTask = {
      ...(existing ?? {
        id,
        bornTurnSequence: parent?.turnSequence ?? sequence,
        description: string(message.description) ?? "Task",
      }),
      status,
      toolUseId: string(message.tool_use_id) ?? existing?.toolUseId,
      description: (string(patch.description) ?? existing?.description ?? "Task").slice(0, 8192),
      taskType: (string(message.task_type) ?? existing?.taskType)?.slice(0, 128),
      workflowName: (string(message.workflow_name) ?? existing?.workflowName)?.slice(0, 256),
      spawnDepth:
        typeof message.spawn_depth === "number" &&
        Number.isSafeInteger(message.spawn_depth) &&
        message.spawn_depth >= 0
          ? message.spawn_depth
          : existing?.spawnDepth,
      role: (string(message.subagent_type) ?? existing?.role)?.slice(0, 256),
      parentTaskId: parent?.update.actor?.taskId ?? existing?.parentTaskId,
      model: string(parentInput.model) ?? existing?.model,
      effort: string(parentInput.effort) ?? existing?.effort,
      backgrounded:
        typeof patch.is_backgrounded === "boolean" ? patch.is_backgrounded : existing?.backgrounded,
      hidden:
        typeof message.skip_transcript === "boolean" ? message.skip_transcript : existing?.hidden,
      ambient: typeof message.ambient === "boolean" ? message.ambient : existing?.ambient,
      summary: (string(message.summary) ?? existing?.summary)?.slice(0, 8192),
      outputFile: (string(message.output_file) ?? existing?.outputFile)?.slice(0, 2048),
      error: (string(patch.error) ?? existing?.error)?.slice(0, 8192),
      lastToolName: string(message.last_tool_name) ?? existing?.lastToolName,
      ...(message.usage
        ? {
            usage: {
              ...claudeTokenUsage(usage),
              totalTokens: claudeNumber(usage.total_tokens),
              toolUses: claudeNumber(usage.tool_uses),
            },
            elapsedSeconds: claudeNumber(usage.duration_ms) / 1000,
          }
        : {}),
      resourceLinks: resources(message.resource_links).length
        ? resources(message.resource_links)
        : existing?.resourceLinks,
    };
    const old = (snapshot.tasks ?? []).filter((entry) => entry.id !== id);
    let completed = old
      .filter((entry) => ["completed", "failed", "cancelled"].includes(entry.status))
      .slice(-512);
    const live = old.filter(
      (entry) => !["completed", "failed", "cancelled"].includes(entry.status),
    );
    while (completed.length && registryBytes([...completed, ...live, task]) > 192 * 1024)
      completed = completed.slice(1);
    const retained = [...completed, ...live, task];
    let next: AgentConversationSnapshot = { ...snapshot, tasks: retained };
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      for (const entry of next.toolCalls ?? []) {
        if (
          entry.update.toolCallId !== task.toolUseId &&
          entry.update.actor?.taskId !== id &&
          entry.update.actor?.parentToolUseId !== task.toolUseId
        )
          continue;
        if (entry.update.status !== "in_progress" && entry.update.status !== "pending") continue;
        next = upsertTool(next, entry.turnSequence, {
          ...entry.update,
          status: task.status,
          detail:
            entry.update.toolCallId === task.toolUseId
              ? (task.summary ?? entry.update.detail)
              : entry.update.detail,
          resources: task.resourceLinks ?? entry.update.resources,
        });
      }
    }
    return next;
  };
  const projectMessage = (
    snapshot: AgentConversationSnapshot,
    message: SDKMessage,
    sequence: number | null,
  ): AgentConversationSnapshot => {
    if (!(message.type in CLAUDE_EVENT_DISPOSITIONS))
      return diagnostic(
        snapshot,
        sequence,
        "unknown-event",
        `Unsupported Claude event: ${String(message.type)}`,
        "warning",
      );
    if (message.type === "assistant" || message.type === "user") {
      if (
        message.type === "assistant" &&
        !message.parent_tool_use_id &&
        !string(claudeRecord(message).parent_agent_id)
      ) {
        mainModel = message.message.model ?? mainModel;
        const usage = claudeTokenUsage(message.message.usage);
        currentUsage = { ...usage, output: Math.max(currentUsage.output, usage.output) };
        contextOutputTokens = Math.max(contextOutputTokens, usage.output);
        if (usage.input + usage.cacheRead + usage.cacheWrite > 0)
          contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      }
      if (
        message.type === "user" &&
        !message.parent_tool_use_id &&
        !string(claudeRecord(message).parent_agent_id) &&
        message.isSynthetic !== true &&
        claudeRecord(message).isMeta !== true &&
        blocksOf(message.message).every((part) => part.type === "text" || part.type === "image")
      ) {
        const turn = snapshot.turns.find((value) => value.sequence === sequence);
        const acceptedTurn = snapshot.turns.find((value) =>
          value.updates.some(
            (entry) => message.uuid && entry.key === claudeAcceptedInputKey(message.uuid),
          ),
        );
        const accepted = acceptedTurn?.updates.find(
          (value) => message.uuid && value.key === claudeAcceptedInputKey(message.uuid),
        );
        if (accepted?.kind === "message" && message.uuid && acceptedTurn)
          return update(snapshot, acceptedTurn.sequence, {
            ...accepted,
            text: claudeHistoryPromptText(message),
            promptImages: promptImages(message.uuid, message.message),
            recordIds: [message.uuid],
          });
        if (
          turn &&
          (turn.nativeUserMessageId === message.uuid ||
            turn.clientUserMessageId === message.uuid ||
            (!turn.nativeUserMessageId && claudeRecord(message).isReplay !== true))
        )
          return {
            ...snapshot,
            turns: snapshot.turns.map((value) =>
              value === turn && value.nativeUserMessageId === undefined
                ? {
                    ...value,
                    nativeUserMessageId: message.uuid,
                    promptImages: promptImages(message.uuid, message.message),
                  }
                : value,
            ),
          };
        if (claudeRecord(message).isReplay === true) return snapshot;
      }
      return projectContent(
        snapshot,
        message.message,
        message.uuid ?? "user",
        sequence,
        message.parent_tool_use_id,
        message.type === "user" ? message.tool_use_result : undefined,
        string(claudeRecord(message).parent_agent_id),
        message.type === "assistant",
      );
    }
    if (message.type === "stream_event") {
      const event = message.event;
      const parent = message.parent_tool_use_id ?? "root";
      if (event.type === "message_start") {
        streamIds.set(parent, event.message.id);
        if (!message.parent_tool_use_id) {
          mainModel = event.message.model;
          currentUsage = claudeTokenUsage(event.message.usage);
          contextTokens = currentUsage.input + currentUsage.cacheRead + currentUsage.cacheWrite;
          contextOutputTokens = currentUsage.output;
        }
        return snapshot;
      }
      const id = streamIds.get(parent);
      if (!id) return snapshot;
      if (event.type === "message_stop") {
        streamIds.delete(parent);
        return snapshot;
      }
      if (event.type === "message_delta") {
        if (message.parent_tool_use_id) return snapshot;
        currentUsage = { ...currentUsage, output: claudeNumber(event.usage.output_tokens) };
        contextOutputTokens = currentUsage.output;
        return update(snapshot, sequence, {
          kind: "usage",
          key: "usage",
          used: contextTokens + contextOutputTokens,
          size:
            snapshot.turns
              .flatMap((turn) => turn.updates)
              .findLast((value) => value.kind === "usage")?.size ?? 0,
          cost: null,
          tokens: currentUsage,
          model: mainModel,
          contextEstimated: true,
        });
      }
      if (event.type !== "content_block_start" && event.type !== "content_block_delta")
        return snapshot;
      const identity = identityFor(message.parent_tool_use_id, id);
      const existing = messageBlocks.get(identity) ?? [];
      const actor = actorFor(snapshot, message.parent_tool_use_id);
      if (event.type === "content_block_start") {
        const part = claudeRecord(event.content_block);
        const toolId = string(part.id);
        const block: Block = {
          index: event.index,
          type: string(part.type) ?? "unknown",
          key: toolId
            ? `tool:${toolId}`
            : `message:${message.parent_tool_use_id ? `${message.parent_tool_use_id}:` : ""}${id}:${event.index}`,
          toolId,
          recordIds: [],
        };
        messageBlocks.set(identity, [
          ...existing.filter((entry) => entry.index !== event.index),
          block,
        ]);
        return projectBlock(snapshot, sequence, part, block, actor);
      }
      const block = existing.find((entry) => entry.index === event.index);
      if (!block) return snapshot;
      const delta = event.delta;
      if (delta.type === "text_delta" || delta.type === "thinking_delta")
        return projectBlock(
          snapshot,
          sequence,
          {
            type: delta.type === "text_delta" ? "text" : "thinking",
            text: delta.type === "text_delta" ? delta.text : delta.thinking,
          },
          block,
          actor,
          undefined,
          true,
        );
      if (delta.type !== "input_json_delta" || !block.toolId) return snapshot;
      const inputJson = `${block.inputJson ?? ""}${delta.partial_json}`.slice(0, 65536);
      messageBlocks.set(
        identity,
        existing.map((entry) => (entry.index === event.index ? { ...entry, inputJson } : entry)),
      );
      const previous = previousTool(snapshot, block.toolId);
      if (!previous) return snapshot;
      let input: unknown;
      try {
        input = JSON.parse(inputJson);
      } catch {
        input = undefined;
      }
      return upsertTool(snapshot, sequence, {
        ...previous.update,
        input: input === undefined ? inputJson : json(input),
        locations: input === undefined ? previous.update.locations : locations(input),
      });
    }
    if (message.type === "result") {
      const chosenModel = mainModel ?? snapshot.metadata?.effectiveSelection?.model ?? undefined;
      const selectedUsage = chosenModel ? message.modelUsage[chosenModel] : undefined;
      const cumulativeTokens = Object.values(message.modelUsage).reduce((sum, usage) => {
        const part = claudeTokenUsage(usage);
        return {
          input: sum.input + part.input,
          output: sum.output + part.output,
          cacheRead: sum.cacheRead + part.cacheRead,
          cacheWrite: sum.cacheWrite + part.cacheWrite,
        };
      }, claudeTokenUsage({}));
      let next = update(snapshot, sequence, {
        kind: "usage",
        key: "usage",
        used: contextTokens + contextOutputTokens,
        size:
          selectedUsage?.contextWindow ??
          (Object.keys(message.modelUsage).length === 1
            ? (Object.values(message.modelUsage)[0]?.contextWindow ?? 0)
            : 0),
        cost: { amount: message.total_cost_usd, currency: "USD" },
        tokens: claudeTokenUsage(message.usage),
        cumulativeTokens,
        model: chosenModel,
        contextEstimated: true,
      });
      if (
        message.subtype === "success" &&
        !message.is_error &&
        message.result &&
        !next.turns
          .find((turn) => turn.sequence === sequence)
          ?.updates.some(
            (entry) => entry.kind === "message" && entry.role === "agent" && !entry.actor,
          )
      )
        next = update(next, sequence, {
          kind: "message",
          key: `result:${message.uuid}`,
          messageId: message.uuid,
          role: "agent",
          text: message.result,
          recordIds: [message.uuid],
        });
      const resultFields = claudeRecord(message);
      const flags = Object.fromEntries(
        [
          "result_index",
          "user_message_uuid",
          "user_message_uuids",
          "queued_turn_count",
          "resume_reason",
        ]
          .filter((key) => resultFields[key] !== undefined)
          .map((key) => [key, resultFields[key]]),
      );
      if (Object.keys(flags).length)
        next = diagnostic(next, sequence, "result-flags", "Native result metadata", "info", flags);
      return next;
    }
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info;
      return update(snapshot, sequence, {
        kind: "rate-limit",
        key: `rate-limit:${info.rateLimitType ?? "subscription"}`,
        status: info.status,
        limitType: info.rateLimitType,
        resetsAt: info.resetsAt,
        utilization: info.utilization,
        overageStatus: info.overageStatus,
        overageReason: info.overageDisabledReason,
        usingOverage: info.isUsingOverage ?? info.overageInUse,
      });
    }
    if (message.type === "tool_progress") {
      const previous = previousTool(snapshot, message.tool_use_id);
      return upsertTool(snapshot, sequence, {
        ...(previous?.update ??
          tool(
            message.tool_use_id,
            message.tool_name,
            actorFor(snapshot, message.parent_tool_use_id),
          )),
        elapsedSeconds: message.elapsed_time_seconds,
        progress: message.subagent_retry
          ? `Retry ${message.subagent_retry.attempt}/${message.subagent_retry.max_retries}`
          : previous?.update.progress,
        actor: {
          ...previous?.update.actor,
          ...actorFor(snapshot, message.parent_tool_use_id),
          ...(message.task_id ? { taskId: message.task_id } : {}),
        },
      });
    }
    if (message.type === "tool_use_summary") {
      let next = snapshot;
      for (const id of message.preceding_tool_use_ids) {
        const previous = previousTool(next, id);
        if (previous)
          next = upsertTool(next, previous.turnSequence, {
            ...previous.update,
            progress: message.summary,
          });
      }
      return next;
    }
    if (message.type === "auth_status")
      return diagnostic(
        snapshot,
        sequence,
        "auth-status",
        message.error ?? message.output.join("\n"),
        message.error ? "error" : "info",
      );
    if (message.type === "prompt_suggestion")
      return diagnostic(snapshot, sequence, "prompt-suggestion", message.suggestion);
    if (message.type === "conversation_reset") {
      contextTokens = 0;
      contextOutputTokens = 0;
      currentUsage = claudeTokenUsage({});
      streamIds.clear();
      messageBlocks.clear();
      toolVersions.clear();
      return {
        ...snapshot,
        sessionId: message.new_conversation_id,
        turns: [],
        // Reset discards conversation content, not workers owned by the same Query.
        tasks: snapshot.tasks
          ?.filter(
            (task) =>
              (task.backgrounded || task.ambient) &&
              isAgentConversationTaskLiveInSnapshot(task, snapshot),
          )
          .map((task) => ({ ...task, bornTurnSequence: null })),
        toolCalls: [],
        requests: [],
        error: null,
        status: "idle",
      };
    }
    if (message.type !== "system") return snapshot;
    if (!(message.subtype in CLAUDE_SYSTEM_EVENT_DISPOSITIONS))
      return diagnostic(
        snapshot,
        sequence,
        "unknown-system-event",
        `Unsupported Claude event: ${String(message.subtype)}`,
        "warning",
      );
    if (message.subtype === "background_tasks_changed") {
      let next = snapshot;
      for (const task of message.tasks)
        next = projectTask(next, sequence, {
          ...task,
          subtype: "task_started",
          is_backgrounded: true,
        });
      return { ...next, liveBackgroundTaskIds: message.tasks.map((task) => task.task_id) };
    }
    if (
      ["task_started", "task_progress", "task_notification", "task_updated"].includes(
        message.subtype,
      )
    )
      return projectTask(snapshot, sequence, claudeRecord(message));
    if (message.subtype === "commands_changed")
      return update(snapshot, null, {
        kind: "commands",
        key: "commands",
        commands: message.commands.map((command) => ({
          name: command.name,
          description: command.description,
          inputHint: command.argumentHint ?? null,
        })),
      });
    if (message.subtype === "compact_boundary") {
      const compact = message.compact_metadata;
      if (compact.post_tokens !== undefined) {
        contextTokens = compact.post_tokens;
        contextOutputTokens = 0;
      }
      const active = snapshot.turns
        .find((turn) => turn.sequence === sequence)
        ?.updates.find((value) => value.kind === "compaction" && value.status === "in_progress");
      let next = update(snapshot, sequence, {
        kind: "compaction",
        key: active?.key ?? `compact:${message.uuid}`,
        compactionId: message.uuid,
        status: "completed",
        summary: "Context compacted",
        error: null,
        trigger: compact.trigger,
        preTokens: compact.pre_tokens,
        postTokens: compact.post_tokens,
        durationMs: compact.duration_ms,
      });
      const usage = snapshot.turns
        .flatMap((turn) => turn.updates)
        .findLast((entry) => entry.kind === "usage");
      if (usage?.kind === "usage" && compact.post_tokens !== undefined)
        next = update(next, sequence, { ...usage, used: compact.post_tokens });
      return next;
    }
    if (message.subtype === "status") {
      let next = snapshot;
      if (message.permissionMode)
        next = update(next, null, {
          kind: "mode",
          key: "mode",
          currentModeId: message.permissionMode,
        });
      if (message.status === "compacting" || message.compact_result)
        next = update(next, sequence, {
          kind: "compaction",
          key: "compact:active",
          compactionId: "active",
          status:
            message.compact_result === "failed"
              ? "failed"
              : message.compact_result === "success"
                ? "completed"
                : "in_progress",
          summary:
            message.compact_result === "failed"
              ? "Context compaction failed"
              : "Compacting context",
          error: message.compact_error ?? null,
        });
      return next;
    }
    if (message.subtype === "init") {
      mainModel = message.model;
      let next = update(snapshot, null, {
        kind: "mode",
        key: "mode",
        currentModeId: message.permissionMode,
      });
      return next;
    }
    if (message.subtype === "model_refusal_fallback") {
      const removed = new Set(message.retracted_message_uuids ?? []);
      let next: AgentConversationSnapshot = {
        ...snapshot,
        turns: snapshot.turns.map((turn) => ({
          ...turn,
          updates: turn.updates.filter((entry) => !entry.recordIds?.some((id) => removed.has(id))),
        })),
        toolCalls: snapshot.toolCalls?.filter(
          (entry) => !entry.update.recordIds?.some((id) => removed.has(id)),
        ),
      };
      for (const [id, versions] of toolVersions) {
        if (!versions.some((version) => removed.has(version.uuid))) continue;
        const retained = versions.filter((version) => !removed.has(version.uuid));
        toolVersions.set(id, retained);
        const last = retained.at(-1);
        if (last)
          next = upsertTool(next, last.turnSequence, {
            ...last.update,
            recordIds: last.update.recordIds?.filter((uuid) => !removed.has(uuid)),
          });
      }
      if (message.scope !== "local" && next.metadata?.effectiveSelection)
        next = {
          ...next,
          metadata: {
            ...next.metadata,
            revision: next.metadata.revision + 1,
            effectiveSelection: {
              ...next.metadata.effectiveSelection,
              model: message.fallback_model,
            },
          },
        };
      return diagnostic(
        next,
        sequence,
        `model-fallback:${message.uuid}`,
        message.content,
        "warning",
        {
          originalModel: message.original_model,
          fallbackModel: message.fallback_model,
          scope: message.scope ?? "session",
        },
      );
    }
    if (message.subtype === "local_command_output")
      return update(snapshot, sequence, {
        kind: "message",
        key: `command:${message.uuid}`,
        role: "agent",
        messageId: message.uuid,
        text: message.content,
        recordIds: [message.uuid],
      });
    if (message.subtype === "files_persisted")
      return diagnostic(
        snapshot,
        sequence,
        `files:${message.uuid}`,
        [
          ...message.files.map((file) => `Saved ${file.filename}`),
          ...message.failed.map((file) => `${file.filename}: ${file.error}`),
        ].join("\n") || "No files saved",
        message.failed.length ? "error" : "info",
        { files: message.files, failed: message.failed },
      );
    if (message.subtype === "api_retry")
      return diagnostic(
        snapshot,
        sequence,
        "api-retry",
        `Retrying Claude request (${message.attempt}/${message.max_retries})`,
        "warning",
        { delayMs: message.retry_delay_ms, status: message.error_status },
      );
    if (message.subtype === "mirror_error")
      return diagnostic(snapshot, sequence, "mirror-error", message.error, "error");
    if (message.subtype === "notification")
      return diagnostic(
        snapshot,
        sequence,
        `notification:${message.key}`,
        message.text,
        message.priority === "high" || message.priority === "immediate" ? "warning" : "info",
      );
    if (message.subtype === "informational")
      return diagnostic(
        snapshot,
        sequence,
        message.tool_use_id ? `tool-info:${message.tool_use_id}` : `info:${message.uuid}`,
        message.content,
        message.level === "warning" ? "warning" : "info",
      );
    if (message.subtype === "model_refusal_no_fallback")
      return diagnostic(snapshot, sequence, "model-refusal", message.content, "warning");
    // All remaining native lifecycle events are retained as bounded diagnostics, never assistant prose.
    const data = claudeRecord(message);
    return diagnostic(
      snapshot,
      sequence,
      `${message.subtype}:${message.uuid}`,
      claudeText(data.content ?? data.error ?? data.output ?? data.state ?? message.subtype),
      data.outcome === "error" || message.subtype === "permission_denied" ? "warning" : "info",
      data,
    );
  };
  return (snapshot: AgentConversationSnapshot, message: SDKMessage, sequence: number | null) => {
    if (message.type !== "stream_event" && message.uuid && seenRecords.has(message.uuid))
      return snapshot;
    if (message.type !== "stream_event" && message.uuid) {
      seenRecords.add(message.uuid);
      if (seenRecords.size > 4096) seenRecords.delete(seenRecords.values().next().value!);
    }
    const next = projectMessage(snapshot, message, sequence);
    return next === snapshot ? snapshot : { ...next, revision: snapshot.revision + 1 };
  };
};

/** Native history shares live block/tool identity; only non-synthetic root user messages open turns. */
export const projectClaudeHistory = (
  snapshot: AgentConversationSnapshot,
  messages: readonly SessionMessage[],
): AgentConversationSnapshot => {
  const project = createClaudeMessageProjection();
  let next = snapshot;
  let sequence = snapshot.turns.at(-1)?.sequence ?? 0;
  for (const message of messages) {
    const data = claudeRecord(message.message);
    const wrapper = claudeRecord(message);
    const prompt =
      claudeHistoryPromptText(message) ||
      (blocksOf(message.message).some((part) => part.type === "image") ? "[Image]" : "");
    if (isClaudeHistoryPrompt(message)) {
      sequence += 1;
      next = beginAgentConversationTurn(next, sequence, prompt, message.uuid);
      next = {
        ...next,
        turns: next.turns.map((turn) =>
          turn.sequence === sequence
            ? {
                ...turn,
                nativeUserMessageId: message.uuid,
                promptImages: promptImages(message.uuid, message.message),
                createdAt: string(wrapper.timestamp ?? data.timestamp),
              }
            : turn,
        ),
      };
      continue;
    }
    if (message.type !== "assistant" && message.type !== "user") continue;
    next = project(
      next,
      {
        ...message,
        message: message.message,
        parent_tool_use_id: message.parent_tool_use_id ?? null,
      } as SDKMessage,
      sequence || null,
    );
  }
  return {
    ...next,
    status: "idle",
    turns: next.turns.map((turn) => ({
      ...turn,
      status: turn.stopReason ? turn.status : undefined,
      stopReason: turn.stopReason,
    })),
    history: {
      hasOlder: next.turns.length < sequence,
      oldestSequence: next.turns[0]?.sequence ?? null,
      cursor: next.turns[0]?.nativeUserMessageId,
    },
    revision: snapshot.revision + 1,
  };
};

/** Expands a bounded history window without renumbering the already visible turns. */
export const prependAgentHistory = (
  snapshot: AgentConversationSnapshot,
  olderSnapshot: AgentConversationSnapshot,
  page: { readonly cursor?: string; readonly hasOlder: boolean },
): AgentConversationSnapshot => {
  if (
    snapshot.sessionId !== olderSnapshot.sessionId ||
    snapshot.threadId !== olderSnapshot.threadId
  )
    return snapshot;
  const identities = new Set(
    snapshot.turns.flatMap((turn) =>
      [turn.nativeUserMessageId, turn.clientUserMessageId].filter(
        (id): id is string => typeof id === "string",
      ),
    ),
  );
  const older = olderSnapshot.turns.filter(
    (turn) =>
      ![turn.nativeUserMessageId, turn.clientUserMessageId].some(
        (id) => typeof id === "string" && identities.has(id),
      ),
  );
  const lowest = Math.min(
    0,
    ...snapshot.turns.flatMap((turn) => (turn.sequence === null ? [] : [turn.sequence])),
  );
  const sequenceMap = new Map(
    older.map((turn, index) => [turn.sequence, lowest - older.length + index]),
  );
  const windowSize = Math.min(
    512,
    Math.max(snapshot.history?.windowSize ?? 64, snapshot.turns.length + older.length),
  );
  let admittedStart = older.length;
  let turns = snapshot.turns;
  let windowFull = false;
  // Admit from the page's newest boundary so the next cursor never skips omitted turns.
  for (let index = older.length - 1; index >= 0; index--) {
    const added = older.slice(index).map((turn) => ({
      ...turn,
      sequence: sequenceMap.get(turn.sequence)!,
    }));
    const candidate = [...added, ...snapshot.turns];
    const bounded = boundAgentConversationTurns(candidate, windowSize);
    if (bounded.length !== candidate.length) {
      windowFull = true;
      break;
    }
    // One bounded turn must remain loadable even at the per-turn byte boundary.
    if (admittedStart < older.length && registryBytes(added) > 512 * 1024) break;
    turns = bounded;
    admittedStart = index;
  }
  const admittedSequences = new Set(older.slice(admittedStart).map((turn) => turn.sequence));
  const taskIds = new Set((snapshot.tasks ?? []).map((task) => task.id));
  const toolIds = new Set((snapshot.toolCalls ?? []).map((tool) => tool.update.toolCallId));
  const clipped = admittedStart > 0;
  return {
    ...snapshot,
    turns,
    tasks: [
      ...(olderSnapshot.tasks ?? [])
        .filter((task) => !taskIds.has(task.id) && admittedSequences.has(task.bornTurnSequence))
        .map((task) => ({
          ...task,
          bornTurnSequence: sequenceMap.get(task.bornTurnSequence) ?? task.bornTurnSequence,
        })),
      ...(snapshot.tasks ?? []),
    ],
    toolCalls: boundToolRegistry([
      ...(olderSnapshot.toolCalls ?? [])
        .filter(
          (tool) =>
            !toolIds.has(tool.update.toolCallId) && admittedSequences.has(tool.turnSequence),
        )
        .map((tool) => ({
          ...tool,
          turnSequence: sequenceMap.get(tool.turnSequence) ?? tool.turnSequence,
        })),
      ...(snapshot.toolCalls ?? []),
    ]),
    history: {
      hasOlder: page.hasOlder || olderSnapshot.history?.hasOlder === true || clipped,
      oldestSequence: turns[0]?.sequence ?? null,
      cursor:
        clipped || olderSnapshot.history?.hasOlder
          ? turns[0]?.nativeUserMessageId
          : (page.cursor ?? turns[0]?.nativeUserMessageId),
      windowSize,
      windowFull,
    },
    revision: snapshot.revision + 1,
  };
};
