import { expect, it, vi } from "vite-plus/test";
import { NativeAgentDraftOwner } from "./native-agent-draft-owner";

it("shares complete draft intent across presentations and isolates profile scopes", () => {
  const owner = new NativeAgentDraftOwner();
  const main = vi.fn();
  const dock = vi.fn();
  const releaseMain = owner.subscribe("session/project/claude/work", main);
  const releaseDock = owner.subscribe("session/project/claude/work", dock);
  owner.write("session/project/claude/work", {
    selection: { model: "default", effort: "high", fast: false },
    mode: "plan",
  });
  expect(main).toHaveBeenCalledOnce();
  expect(dock).toHaveBeenCalledOnce();
  releaseMain();
  expect(owner.read("session/project/claude/work")).toEqual({
    selection: { model: "default", effort: "high", fast: false },
    mode: "plan",
  });
  expect(owner.read("session/project/claude/personal").selection).toEqual({
    model: "default",
    effort: "default",
  });
  owner.clear("session/project/claude/work");
  expect(owner.read("session/project/claude/work").mode).toBe("default");
  expect(dock).toHaveBeenCalledTimes(2);
  releaseDock();
});
