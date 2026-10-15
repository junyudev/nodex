import { describe, expect, it } from "vite-plus/test";

import { NODEX_APP_TASK_TOOL_NAMES, resolveNodexAppTaskTool } from "./nodexAppMcp.ts";

describe("resolveNodexAppTaskTool", () => {
  it("recognizes every Runtime tool across provider spellings", () => {
    for (const tool of NODEX_APP_TASK_TOOL_NAMES) {
      for (const label of [
        `mcp__nodex_app__${tool}`,
        `nodex_app.${tool}`,
        `nodex_app_${tool}`,
        `nodex-app:${tool}`,
        `nodex_app-thread_parent_${tool}`,
        `nodex_app · ${tool} completed`,
      ]) {
        expect(resolveNodexAppTaskTool(label), label).toBe(tool);
      }
      expect(resolveNodexAppTaskTool(`mcp__another-server__${tool}`)).toBeNull();
    }
  });

  it("leaves unknown tools to generic presentation", () => {
    expect(resolveNodexAppTaskTool("nodex_app_not_a_tool")).toBeNull();
    expect(resolveNodexAppTaskTool("nodex_app-thread_parent_not_a_tool")).toBeNull();
  });
});
