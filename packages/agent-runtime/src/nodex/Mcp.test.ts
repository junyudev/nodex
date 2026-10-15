import { expect, it } from "@effect/vitest";
import { executionToolkit } from "./Mcp.ts";

it("publishes delegation and tree controls while Session creation and scheduling belong to the host", () => {
  const names = Object.keys(executionToolkit.tools);
  expect(names).toEqual(
    expect.arrayContaining([
      "delegate_task",
      "task_status",
      "task_cancel",
      "t3_thread_read",
      "t3_thread_send",
    ]),
  );
  expect(names).not.toEqual(expect.arrayContaining(["create_threads"]));
  expect(names).not.toEqual(expect.arrayContaining(["schedule_task"]));
});
