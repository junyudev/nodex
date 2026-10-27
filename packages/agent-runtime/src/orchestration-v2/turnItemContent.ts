import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { imageAvailabilityText } from "@t3tools/provider-core/server/handoffBudget";

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function turnItemText(item: OrchestrationV2TurnItem): string | null {
  const text = turnItemContentText(item);
  const images = imageAvailabilityText(item);
  return images.length === 0 ? text : [text, ...images].filter(Boolean).join("\n");
}

function turnItemContentText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "notification":
      return [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return [item.explanation, ...item.steps.map((step) => `[${step.status}] ${step.text}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "user_input_request":
      return jsonText(item.questions);
    case "file_change":
      return [
        ...(item.changes?.length
          ? item.changes.flatMap((change) => [
              [
                change.operation,
                change.oldPath === undefined ? change.path : `${change.oldPath} -> ${change.path}`,
                change.additions === undefined
                  ? undefined
                  : `+${change.additions} -${change.deletions ?? 0}`,
              ]
                .filter((part) => part !== undefined)
                .join(" "),
              change.diff,
            ])
          : [item.fileName]),
        item.diffStr,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "command_execution":
      return [`$ ${item.input}`, item.output]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "file_search":
      return jsonText({ pattern: item.pattern, results: item.results });
    case "web_search":
      return jsonText({ patterns: item.patterns, results: item.results });
    case "approval_request":
      return item.prompt ?? item.requestKind;
    case "checkpoint":
      return jsonText(item.files);
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return "Forked into a new conversation.";
    case "context_cleared":
      return "The person cleared the context here; later messages started fresh.";
    case "thread_created":
      return `Created a conversation with ${item.targetProviderInstanceId} (${item.targetModel}).`;
    case "secret_request":
      return `Asked the user for ${item.label}: ${item.secretStatus}.`;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
    case "hook_run":
      return [`${item.eventName} hook ${item.hookStatus}`, item.statusMessage]
        .filter((line): line is string => line !== null)
        .join("\n");
    case "approval_review":
      return [`${item.actionSummary}: ${item.decision}`, item.rationale]
        .filter((line): line is string => line !== null)
        .join("\n");
  }
}
