import { act } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { AgentSessionConfigSelectOption } from "../../../shared/agent-conversation";
import { useClaudeModelCatalog } from "./use-claude-model-catalog";

const deferred = () => {
  let resolve!: (models: readonly AgentSessionConfigSelectOption[]) => void;
  const promise = new Promise<readonly AgentSessionConfigSelectOption[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const options = (value: string) => [{ value, name: value, description: null }];

test("keeps model discovery scoped to the current instance and Project when replies race", async () => {
  const first = deferred();
  const second = deferred();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(
    ({ instance, project }) => useClaudeModelCatalog(instance, project, read),
    {
      initialProps: { instance: "personal", project: "project-a" },
    },
  );
  rerender({ instance: "work", project: "project-b" });
  await act(async () => {
    second.resolve(options("gateway/model-b"));
  });
  await waitFor(() => expect(result.current.options).toEqual(options("gateway/model-b")));
  await act(async () => {
    first.resolve(options("claude-sonnet-5"));
  });
  expect(result.current.options).toEqual(options("gateway/model-b"));
  expect(read.mock.calls).toEqual([
    [{ instanceConfigId: "personal", projectId: "project-a" }],
    [{ instanceConfigId: "work", projectId: "project-b" }],
  ]);
});

test("keeps discovery failures explicit while allowing the configured default", async () => {
  const read = vi.fn().mockRejectedValue(new Error("private launch details"));
  const { result } = renderHook(() => useClaudeModelCatalog("work", "project", read));
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current.options.map(({ value }) => value)).toEqual(["default"]);
  expect(result.current.error).not.toContain("private launch details");
});
