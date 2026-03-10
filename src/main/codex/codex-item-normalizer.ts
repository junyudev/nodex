import type {
  CodexCommandAction,
  CodexItemStatus,
  CodexItemView,
  CodexToolCallSubtype,
  CodexToolCallView,
  CodexUserInputQuestion,
} from "../../shared/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function normalizeTypeName(type: string): string {
  return type.replace(/[_\-\s]/g, "").toLowerCase();
}

function isType(type: string, accepted: string[]): boolean {
  const normalized = normalizeTypeName(type);
  return accepted.some((candidate) => normalizeTypeName(candidate) === normalized);
}

function getString(candidate: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = candidate[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function getUnknown(candidate: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(candidate, key)) {
      return candidate[key];
    }
  }
  return undefined;
}

function normalizeItemStatus(value: unknown): CodexItemStatus | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeTypeName(value);
  if (normalized === "inprogress") return "inProgress";
  if (normalized === "completed") return "completed";
  if (normalized === "failed") return "failed";
  if (normalized === "declined") return "declined";
  if (normalized === "interrupted") return "interrupted";
  return undefined;
}

function humanizeType(type: string): string {
  const spaced = type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .trim();
  if (!spaced) return "Thread item";
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function parseUserMessageText(candidate: Record<string, unknown>): string {
  const content = Array.isArray(candidate.content) ? candidate.content : [];
  const textParts = content
    .map((entry) => {
      const input = asRecord(entry);
      if (!input || !isType(getString(input, ["type"]) ?? "", ["text"])) return "";
      return getString(input, ["text"]) ?? "";
    })
    .filter((value) => value.length > 0);
  return textParts.join("\n");
}

function parseUserInputQuestions(value: unknown): CodexUserInputQuestion[] {
  if (!Array.isArray(value)) return [];

  return value.reduce<CodexUserInputQuestion[]>((acc, question) => {
    const candidate = asRecord(question);
    if (!candidate) return acc;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.header !== "string" ||
      typeof candidate.question !== "string"
    ) {
      return acc;
    }

    const options = Array.isArray(candidate.options)
      ? candidate.options.reduce<NonNullable<CodexUserInputQuestion["options"]>>((optionAcc, option) => {
        const parsed = asRecord(option);
        if (!parsed) return optionAcc;
        if (typeof parsed.label !== "string" || typeof parsed.description !== "string") {
          return optionAcc;
        }
        optionAcc.push({
          label: parsed.label,
          description: parsed.description,
        });
        return optionAcc;
      }, [])
      : undefined;

    acc.push({
      id: candidate.id,
      header: candidate.header,
      question: candidate.question,
      isOther: Boolean(candidate.isOther),
      isSecret: Boolean(candidate.isSecret),
      options,
    });
    return acc;
  }, []);
}

function parseUserInputAnswers(value: unknown): Record<string, string[]> | undefined {
  const candidate = asRecord(value);
  if (!candidate) return undefined;

  const answers = Object.entries(candidate).reduce<Record<string, string[]>>((acc, [questionId, rawValue]) => {
    if (Array.isArray(rawValue)) {
      acc[questionId] = rawValue.filter((entry): entry is string => typeof entry === "string");
      return acc;
    }

    const nested = asRecord(rawValue);
    if (!nested || !Array.isArray(nested.answers)) return acc;
    acc[questionId] = nested.answers.filter((entry): entry is string => typeof entry === "string");
    return acc;
  }, {});

  return Object.keys(answers).length > 0 ? answers : undefined;
}

function formatAskedQuestionLabel(count: number): string {
  if (count <= 0) return "Asked for input";
  return count === 1 ? "Asked 1 question" : `Asked ${count} questions`;
}

function resolveToolCallError(candidate: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(candidate.error);
  return (
    getString(candidate, ["errorMessage", "error_message"]) ??
    (errorRecord ? getString(errorRecord, ["message"]) : undefined)
  );
}

function buildToolCall(
  subtype: CodexToolCallSubtype,
  toolName: string,
  extras?: Partial<CodexToolCallView>,
): CodexToolCallView {
  return {
    subtype,
    toolName,
    server: extras?.server,
    args: extras?.args,
    result: extras?.result,
    error: extras?.error,
  };
}

function extractFileChanges(candidate: Record<string, unknown>): {
  label?: string;
  diff?: string;
  paths: string[];
  parsedChanges: Array<{ path?: string; diff?: string }>;
} {
  const changes = Array.isArray(candidate.changes) ? candidate.changes : [];
  if (changes.length === 0) return { paths: [], parsedChanges: [] };

  const diffs: string[] = [];
  const paths: string[] = [];
  const parsedChanges: Array<{ path?: string; diff?: string }> = [];

  for (const change of changes) {
    const parsed = asRecord(change);
    if (!parsed) continue;
    const path = getString(parsed, ["path"]);
    const diff = getString(parsed, ["diff"]);
    parsedChanges.push({ path, diff });
    if (path) paths.push(path);
    if (diff) diffs.push(diff);
  }

  const uniquePaths = Array.from(new Set(paths));
  const label =
    uniquePaths.length === 0
      ? undefined
      : uniquePaths.length === 1
        ? `Edited ${uniquePaths[0]}`
        : `Edited ${uniquePaths[0]} and ${uniquePaths.length - 1} more file(s)`;

  return {
    label,
    diff: diffs.length > 0 ? diffs.join("\n\n") : undefined,
    paths: uniquePaths,
    parsedChanges,
  };
}

function parseCommandActions(value: unknown): CodexCommandAction[] {
  if (!Array.isArray(value)) return [];

  const actions: CodexCommandAction[] = [];
  for (const rawAction of value) {
    const candidate = asRecord(rawAction);
    if (!candidate) continue;

    const actionType = getString(candidate, ["type"]);
    if (!actionType) continue;

    if (isType(actionType, ["read"])) {
      const command = getString(candidate, ["command", "cmd"]) ?? "";
      const name = getString(candidate, ["name"]) ?? getString(candidate, ["path"]) ?? command;
      const path = getString(candidate, ["path"]) ?? name;
      if (!name || !path) continue;
      actions.push({ type: "read", command, name, path });
      continue;
    }

    if (isType(actionType, ["listFiles", "list_files"])) {
      const command = getString(candidate, ["command", "cmd"]) ?? "";
      const path = typeof candidate.path === "string" ? candidate.path : null;
      actions.push({ type: "listFiles", command, path });
      continue;
    }

    if (isType(actionType, ["search"])) {
      const command = getString(candidate, ["command", "cmd"]) ?? "";
      const query = typeof candidate.query === "string" ? candidate.query : null;
      const path = typeof candidate.path === "string" ? candidate.path : null;
      actions.push({ type: "search", command, query, path });
      continue;
    }

    if (isType(actionType, ["unknown"])) {
      const command = getString(candidate, ["command", "cmd"]) ?? "";
      actions.push({ type: "unknown", command });
    }
  }

  return actions;
}

function applyFallbackContent(result: CodexItemView, candidate: Record<string, unknown>, type: string): CodexItemView {
  const hasVisibleContent = Boolean(result.markdownText || result.toolCall);

  if (hasVisibleContent) return result;

  return {
    ...result,
    markdownText: humanizeType(type),
  };
}

export function normalizeThreadItem(item: unknown, threadId: string, turnId: string): CodexItemView | null {
  const candidate = asRecord(item);
  if (!candidate) return null;

  const itemId = getString(candidate, ["id"]);
  const itemType = getString(candidate, ["type"]);
  if (!itemId || !itemType) return null;

  const now = Date.now();
  const result: CodexItemView = {
    threadId,
    turnId,
    itemId,
    type: itemType,
    normalizedKind: "systemEvent",
    rawItem: candidate,
    createdAt: now,
    updatedAt: now,
  };

  if (isType(itemType, ["userMessage"])) {
    const text = parseUserMessageText(candidate);
    result.normalizedKind = "userMessage";
    result.role = "user";
    result.markdownText = text;
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["agentMessage"])) {
    const text = getString(candidate, ["text"]) ?? "";
    result.normalizedKind = "assistantMessage";
    result.role = "assistant";
    result.markdownText = text;
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["plan"])) {
    const text = getString(candidate, ["text"]) ?? "";
    result.normalizedKind = "plan";
    result.role = "assistant";
    result.markdownText = text;
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["requestUserInput", "request_user_input"])) {
    const questions = parseUserInputQuestions(candidate.questions);
    result.normalizedKind = "userInputRequest";
    result.status = normalizeItemStatus(getUnknown(candidate, ["status"]));
    result.markdownText = formatAskedQuestionLabel(questions.length);
    result.userInputQuestions = questions;
    result.userInputAnswers = parseUserInputAnswers(candidate.answers);
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["reasoning"])) {
    const summary = Array.isArray(candidate.summary)
      ? candidate.summary.filter((entry): entry is string => typeof entry === "string")
      : [];
    const content = Array.isArray(candidate.content)
      ? candidate.content.filter((entry): entry is string => typeof entry === "string")
      : [];
    const text = [...summary, ...content].join("\n");
    result.normalizedKind = "reasoning";
    result.status = normalizeItemStatus(getUnknown(candidate, ["status"]));
    result.markdownText = text;
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["commandExecution", "command_execution"])) {
    const command = getString(candidate, ["command"]);
    const cwd = getString(candidate, ["cwd"]);
    const output = getString(candidate, ["aggregatedOutput", "aggregated_output"]);
    const commandActions = parseCommandActions(candidate.commandActions ?? candidate.command_actions);

    result.normalizedKind = "commandExecution";
    result.status = normalizeItemStatus(getUnknown(candidate, ["status"]));
    result.toolCall = buildToolCall("command", "bash", {
      args: {
        command,
        cwd,
        commandActions: commandActions.length > 0 ? commandActions : undefined,
      },
      result: output,
      error: resolveToolCallError(candidate),
    });
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["fileChange", "file_change"])) {
    const { label, diff, paths, parsedChanges } = extractFileChanges(candidate);
    result.normalizedKind = "fileChange";
    result.status = normalizeItemStatus(getUnknown(candidate, ["status"]));
    result.toolCall = buildToolCall("fileChange", "file_change", {
      args: {
        label,
        changes: parsedChanges,
      },
      result: {
        paths,
        diff,
      },
      error: resolveToolCallError(candidate),
    });
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["mcpToolCall", "mcp_tool_call"])) {
    const server = getString(candidate, ["server"]);
    const tool = getString(candidate, ["tool"]) ?? "mcp_tool";
    const error = resolveToolCallError(candidate);

    result.normalizedKind = "toolCall";
    result.status = normalizeItemStatus(getUnknown(candidate, ["status"]));
    result.toolCall = buildToolCall("mcp", tool, {
      server,
      args: candidate.arguments,
      result: candidate.result,
      error,
    });
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["collabAgentToolCall", "collab_agent_tool_call"])) {
    const tool = getString(candidate, ["tool"]) ?? "collab_tool";
    const sender = getString(candidate, ["senderThreadId", "sender_thread_id"]);
    const receiverIds = Array.isArray(candidate.receiverThreadIds)
      ? candidate.receiverThreadIds.filter((entry): entry is string => typeof entry === "string")
      : [];

    result.normalizedKind = "toolCall";
    result.status = normalizeItemStatus(getUnknown(candidate, ["status"]));
    result.toolCall = buildToolCall("generic", tool, {
      args: {
        sender,
        receivers: receiverIds,
        prompt: getString(candidate, ["prompt"]),
      },
      result: candidate.result,
      error: resolveToolCallError(candidate),
    });
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["webSearch", "web_search"])) {
    const query = getString(candidate, ["query"]);
    result.normalizedKind = "toolCall";
    result.toolCall = buildToolCall("webSearch", "web_search", {
      args: {
        query,
      },
      result: candidate.action ?? candidate.result,
      error: resolveToolCallError(candidate),
    });
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["imageView", "image_view"])) {
    const path = getString(candidate, ["path"]);
    result.normalizedKind = "systemEvent";
    result.markdownText = path ? `Viewed image: ${path}` : "Viewed image";
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["enteredReviewMode", "entered_review_mode"])) {
    const reviewId = getString(candidate, ["review"]);
    result.normalizedKind = "systemEvent";
    result.markdownText = reviewId ? `Entered review mode (${reviewId})` : "Entered review mode";
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["exitedReviewMode", "exited_review_mode"])) {
    const reviewId = getString(candidate, ["review"]);
    result.normalizedKind = "systemEvent";
    result.markdownText = reviewId ? `Exited review mode (${reviewId})` : "Exited review mode";
    return applyFallbackContent(result, candidate, itemType);
  }

  if (isType(itemType, ["contextCompaction", "context_compaction"])) {
    result.normalizedKind = "systemEvent";
    result.markdownText = "Context compacted";
    return applyFallbackContent(result, candidate, itemType);
  }

  return applyFallbackContent(
    result,
    candidate,
    itemType,
  );
}
