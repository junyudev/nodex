import { describe, expect, it } from "vite-plus/test";
import { decideClaudeNativePluginOverrides } from "./ClaudePluginConfig.ts";

describe("Claude native Plugin precedence", () => {
  const native = { id: "entry@marketplace", name: "formatter", enabled: true };
  it("disables the duplicate marketplace entry for the query and leaves other entries alone", () => {
    expect(
      decideClaudeNativePluginOverrides(
        ["formatter"],
        [
          native,
          { id: "other@marketplace", name: "other", enabled: true },
          { ...native, id: "formatter@second", enabled: false },
        ],
      ),
    ).toEqual({ status: "ready", overrides: { "entry@marketplace": false } });
  });

  it.each([
    { ...native, managed: true },
    { ...native, id: "formatter" },
    { ...native, id: "formatter@synced" },
  ])("reports a duplicate that cannot be safely disabled ($id)", (plugin) => {
    expect(decideClaudeNativePluginOverrides(["formatter"], [plugin])).toEqual({
      status: "conflict",
      identity: "formatter",
    });
  });

  it("reports a conflict when a separate launch settings flag would compete with the override", () => {
    expect(decideClaudeNativePluginOverrides(["formatter"], [native], true)).toEqual({
      status: "conflict",
      identity: "formatter",
    });
  });
});
