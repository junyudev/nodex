import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import * as Schema from "effect/Schema";
import { TaskToolkit } from "../mcp/toolkits/task/tools.ts";

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

it("publishes task tools without Runtime conversation identities", () => {
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
