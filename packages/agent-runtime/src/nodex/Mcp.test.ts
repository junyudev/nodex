import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import * as Schema from "effect/Schema";
import { TaskReadResult, TaskToolkit } from "../mcp/toolkits/task/tools.ts";
import { taskReadView } from "../mcp/TaskHistoryRead.ts";

const propertyNames = (schema: unknown): ReadonlyArray<string> => {
  if (Array.isArray(schema)) return schema.flatMap(propertyNames);
  if (typeof schema !== "object" || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) => [
    ...(key === "properties" && typeof value === "object" && value !== null
      ? Object.keys(value)
      : []),
    ...propertyNames(value),
  ]);
};

it("publishes task tools without Runtime conversation routing fields", () => {
  const tools = Object.values(TaskToolkit.tools);
  expect(tools.map((tool) => tool.name).toSorted()).toEqual([
    "delegate_task",
    "list_agent_models",
    "stop_workflow",
    "task_cancel",
    "task_read",
    "task_send",
    "task_status",
    "task_wait",
  ]);
  for (const tool of tools) {
    const fields = [
      ...propertyNames(Tool.getJsonSchema(tool)),
      ...propertyNames(Schema.toJsonSchemaDocument(tool.successSchema)),
    ];
    expect(
      fields.filter((field) => /thread/i.test(field)),
      tool.name,
    ).toEqual([]);
  }
});

it("projects Task routing fields while preserving canonical diagnostic content and opaque continuations", () => {
  const content = {
    format: "json" as const,
    offset: 0,
    totalChars: 123,
    nextCursor: null,
    value: {
      source: "runtime",
      item: {
        threadId: "diagnostic-source",
        output: { senderThreadId: "producer-output", body: "complete" },
      },
    },
  };
  const result = taskReadView({
    items: [
      {
        id: "item",
        sourceThreadId: "private-source",
        senderThreadId: "private-sender",
        runId: null,
        type: "dynamic_tool",
        status: "completed",
        content,
      },
    ],
    page: { nextCursor: "opaque-page" },
  });
  expect(Object.keys(result.items[0]!)).not.toContain("sourceThreadId");
  expect(Object.keys(result.items[0]!)).not.toContain("senderThreadId");
  expect(result.items[0]!.content).toBe(content);
  expect(result.items[0]!.content.value.item).toEqual(content.value.item);
  expect(result.page.nextCursor).toBe("opaque-page");
  const schema = Schema.toJsonSchemaDocument(TaskReadResult);
  expect(propertyNames(schema).filter((field) => /thread/i.test(field))).toEqual([]);
});
