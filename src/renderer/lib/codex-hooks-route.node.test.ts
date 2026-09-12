import { describe, expect, test } from "vite-plus/test";
import {
  buildCodexHooksSettingsPath,
  parseCodexHooksSettingsSelection,
  replaceCodexHooksSettingsSelection,
} from "./codex-hooks-route";

describe("Codex Hooks settings routes", () => {
  test("preserves the exact host, source, project, and plugin query contract", () => {
    expect(
      buildCodexHooksSettingsPath({
        hostId: "remote-1",
        selection: { source: "project", projectRoot: "/workspace/nodex" },
      }),
    ).toBe(
      "/settings/hooks-settings?hostId=remote-1&source=project&projectRoot=%2Fworkspace%2Fnodex",
    );

    expect(
      buildCodexHooksSettingsPath({
        hostId: "local",
        selection: { source: "plugin", pluginId: null },
      }),
    ).toBe("/settings/hooks-settings?hostId=local&source=plugin&pluginId=__unknown__");

    expect(
      buildCodexHooksSettingsPath({
        hostId: "local",
        selection: { source: "plugin" },
      }),
    ).toBe("/settings/hooks-settings?hostId=local&source=plugin");
  });

  test("parses only valid project roots and preserves aggregate versus unknown plugins", () => {
    const roots = ["/workspace/nodex"];
    expect(
      parseCodexHooksSettingsSelection(
        "/settings/hooks-settings?source=project&projectRoot=%2Fworkspace%2Fnodex",
        roots,
      ),
    ).toEqual({ source: "project", projectRoot: "/workspace/nodex" });
    expect(
      parseCodexHooksSettingsSelection(
        "/settings/hooks-settings?source=project&projectRoot=%2Fworkspace%2Fmissing",
        roots,
      ),
    ).toBeNull();
    expect(
      parseCodexHooksSettingsSelection("/settings/hooks-settings?source=plugin", roots),
    ).toEqual({ source: "plugin" });
    expect(
      parseCodexHooksSettingsSelection(
        "/settings/hooks-settings?source=plugin&pluginId=__unknown__",
        roots,
      ),
    ).toEqual({ source: "plugin", pluginId: null });
  });

  test("replaces only Hook routing fields while retaining unrelated query state", () => {
    expect(
      replaceCodexHooksSettingsSelection(
        "/settings/hooks-settings?tab=all&hostId=old&source=plugin&pluginId=old",
        {
          hostId: "local",
          selection: { source: "project", projectRoot: "/workspace/nodex" },
        },
      ),
    ).toBe(
      "/settings/hooks-settings?tab=all&hostId=local&source=project&projectRoot=%2Fworkspace%2Fnodex",
    );

    expect(
      replaceCodexHooksSettingsSelection(
        "/settings/hooks-settings?tab=all&hostId=local&source=user",
        { hostId: "local", selection: null },
      ),
    ).toBe("/settings/hooks-settings?tab=all");
  });
});
