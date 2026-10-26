import { describe, expect, test } from "vite-plus/test";
import {
  buildThreadToolActivityProjectionScenario,
  findProjectedActivityGroup,
  readProjectedActivityEntryTypes,
} from "./thread-tool-activity-projection-fixtures";

describe("thread tool activity projection fixtures", () => {
  test("names reasoning-only work by its heading in a thinking group", () => {
    const { model, transcriptItems } = buildThreadToolActivityProjectionScenario("reasoning-only");
    const group = findProjectedActivityGroup(model.agentBodyUnits);

    expect(transcriptItems.map((item) => item.semanticKind)).toEqual(["reasoning"]);
    expect(group ? readProjectedActivityEntryTypes(group.entries) : []).toEqual(["reasoning"]);
    expect(group?.header).toMatchObject({
      kind: "thinking",
      message: "Preparing the implementation.",
    });
    expect(model.liveActivity).toMatchObject({
      global: { state: { type: "thinking", isVisible: true } },
      fallback: { owner: "group" },
      reasoningSummary: { text: "Preparing the implementation." },
    });
  });

  test("omits an empty live patch until it materializes without losing reasoning", () => {
    const before = buildThreadToolActivityProjectionScenario("pre-patch");
    const after = buildThreadToolActivityProjectionScenario("materialized-patch");

    expect(before.canonicalItems.map((item) => item.type)).toEqual(["reasoning", "fileChange"]);
    expect(before.transcriptItems.map((item) => item.semanticKind)).toEqual(["reasoning"]);
    const thinking = findProjectedActivityGroup(before.model.agentBodyUnits);
    expect(thinking ? readProjectedActivityEntryTypes(thinking.entries) : []).toEqual([
      "reasoning",
    ]);
    expect(before.model.liveActivity).toMatchObject({
      fallback: { owner: "group" },
      reasoningSummary: { text: "Preparing the larger patch." },
    });

    const group = findProjectedActivityGroup(after.model.agentBodyUnits);
    expect(after.transcriptItems.map((item) => item.semanticKind)).toEqual(["reasoning", "patch"]);
    expect(group?.header.kind).toBe("active");
    expect(group?.header.kind === "active" ? group.header.item.type : null).toBe("fileChange");
    expect(group?.bodyEntries.map((entry) => entry.type)).toEqual(["reasoning", "fileChange"]);
    expect(after.model.liveActivity.fallback.owner).toBe("none");
  });

  test("keeps interleaved Thoughts in order inside one mixed tool group", () => {
    const { model, transcriptItems } = buildThreadToolActivityProjectionScenario("mixed-tools");
    const group = findProjectedActivityGroup(model.agentBodyUnits);

    expect(transcriptItems.map((item) => item.semanticKind)).toEqual([
      "exec",
      "reasoning",
      "patch",
      "reasoning",
      "webSearch",
    ]);
    expect(model.agentBodyUnits).toHaveLength(1);
    expect(group?.header.kind).toBe("active");
    expect(group?.header.kind === "active" ? group.header.item.type : null).toBe("webSearch");
    expect(group ? readProjectedActivityEntryTypes(group.entries) : []).toEqual([
      "exec",
      "reasoning",
      "fileChange",
      "reasoning",
      "webSearch",
    ]);
    expect(group?.bodyEntries.map((entry) => entry.type)).toEqual([
      "exec",
      "reasoning",
      "fileChange",
      "reasoning",
      "webSearch",
    ]);
    expect(model.liveActivity.fallback.owner).toBe("none");
  });

  test("demotes settled patch and web singletons to their family rows", () => {
    const patch = buildThreadToolActivityProjectionScenario("completed-patch-singleton");
    const web = buildThreadToolActivityProjectionScenario("completed-web-singleton");

    expect(patch.model.agentBodyUnits.map((unit) => unit.kind)).toEqual(["entry"]);
    expect(patch.model.agentBodyUnits.map((unit) => unit.block.type)).toEqual(["fileChange"]);
    expect(web.model.agentBodyUnits.map((unit) => unit.kind)).toEqual(["entry"]);
    expect(web.model.agentBodyUnits.map((unit) => unit.block.type)).toEqual(["webSearch"]);
  });

  test("retains a settled multi-tool summary group", () => {
    const { model } = buildThreadToolActivityProjectionScenario("settled-mixed-tools");
    const group = findProjectedActivityGroup(model.agentBodyUnits);

    expect(model.agentBodyUnits.map((unit) => unit.kind)).toEqual([
      "agentActivityGroup",
      "entry",
      "entry",
    ]);
    expect(model.agentBodyUnits.map((unit) => unit.block.type)).toEqual([
      "agentActivityGroup",
      "mcpToolCall",
      "dynamicToolCall",
    ]);
    expect(group?.header.kind).toBe("summary");
    expect(group ? readProjectedActivityEntryTypes(group.entries) : []).toEqual([
      "exec",
      "fileChange",
      "webSearch",
    ]);
    expect(group?.completedHeader.parts.length).toBeGreaterThan(0);
    expect(model.liveActivity.fallback.owner).toBe("none");
  });

  test("assigns one thinking owner to the latest completed multi-tool group", () => {
    const { model } = buildThreadToolActivityProjectionScenario("thinking-owner");
    const group = findProjectedActivityGroup(model.agentBodyUnits);

    expect(group?.header).toMatchObject({
      kind: "thinking",
      message: "Verifying the completed edits.",
    });
    expect(group ? readProjectedActivityEntryTypes(group.entries) : []).toEqual([
      "exec",
      "fileChange",
      "reasoning",
    ]);
    expect(model.liveActivity).toMatchObject({
      global: { state: { type: "thinking", isVisible: true } },
      fallback: {
        owner: "group",
        message: "Verifying the completed edits.",
      },
    });
  });

  test("keeps registry-owned dynamic activity outside an ordinary tool group", () => {
    const { model } = buildThreadToolActivityProjectionScenario("active-standalone-dynamic");

    expect(model.agentBodyUnits.map((unit) => unit.kind)).toEqual(["entry"]);
    expect(model.agentBodyUnits.map((unit) => unit.block.type)).toEqual(["dynamicToolCall"]);
    expect(model.liveActivity.fallback.owner).toBe("none");
  });
});
