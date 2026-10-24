import { describe, expect, test } from "vite-plus/test";
import { acpInstanceInput } from "./acp-agent-model";
import { acpAgentDraft, acpDraftChanged, acpDraftInput } from "./acp-agent-draft";
import { localInstance, registryInstance } from "./acp-agents.test-fixtures";

describe("ACP instance drafts", () => {
  test("an unedited draft keeps empty and multi-line arguments exactly", () => {
    const instance = localInstance({
      source: {
        kind: "local",
        executable: "/opt/agents/scripted",
        args: ["--message", "", "first line\nsecond line", "  padded  "],
      },
      environment: [{ name: "TOKEN", sensitive: true, value: null }],
    });
    const draft = acpAgentDraft(instance);
    expect(acpDraftChanged(instance, draft)).toBe(false);

    const renamed = acpDraftInput(acpInstanceInput(instance), { ...draft, displayName: "Renamed" });
    expect(renamed.source).toEqual(instance.source);
    expect(renamed.environment).toEqual([{ name: "TOKEN", sensitive: true, value: null }]);
    expect(renamed.displayName).toBe("Renamed");
  });

  test("a draft applies to the instance as saved, keeping an installation pinned meanwhile", () => {
    const opened = registryInstance();
    const draft = { ...acpAgentDraft(opened), displayName: "Qoder work" };
    const savedSince = acpInstanceInput(
      registryInstance({
        source: {
          kind: "registry",
          agentId: "qoder-cli",
          distribution: "auto",
          installationId: "e".repeat(64),
        },
      }),
    );
    expect(acpDraftInput(savedSince, draft).source).toEqual(savedSince.source);
    // Another distribution belongs to another installation, so the pin is released.
    expect(acpDraftInput(savedSince, { ...draft, distribution: "npx" }).source).toEqual({
      kind: "registry",
      agentId: "qoder-cli",
      distribution: "npx",
    });
  });
});
