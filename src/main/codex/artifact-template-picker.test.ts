import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import {
  buildArtifactTemplatePickerConfig,
  resolveArtifactTemplatePickerRuntime,
} from "./artifact-template-picker";

const skill = (overrides: Partial<SkillMetadata>): SkillMetadata => ({
  name: "artifact-template-sheet",
  description: "Spreadsheet template",
  path: "/skills/sheet/SKILL.md",
  scope: "user",
  enabled: true,
  pluginId: null,
  ...overrides,
});

const runtimeFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-artifact-template-picker-"));
  const serverPath = path.join(root, "server.mjs");
  writeFileSync(serverPath, "export {};\n", "utf8");
  return { nodePath: "/runtime/node", serverPath };
};

describe("artifact template picker", () => {
  test("builds the base MCP server even when skill discovery is unavailable", () => {
    const runtime = runtimeFixture();
    expect(buildArtifactTemplatePickerConfig({ runtime })).toEqual({
      "mcp_servers.openai_artifact_template_picker": {
        command: "/runtime/node",
        args: [runtime.serverPath],
        env: {},
      },
    });
  });

  test("filters, prioritizes, deduplicates and bounds published template skills", () => {
    const runtime = runtimeFixture();
    const longDescription = "😀".repeat(700);
    const config = buildArtifactTemplatePickerConfig({
      runtime,
      platform: "win32",
      skills: [
        skill({
          name: "openai-templates:artifact-template-late",
          path: String.raw`C:\skills\late\SKILL.md`,
        }),
        skill({
          name: "vendor:artifact-template-middle",
          path: String.raw`C:\skills\middle\SKILL.md`,
        }),
        skill({
          name: "artifact-template-first",
          path: String.raw`C:\skills\first\SKILL.md`,
          description: longDescription,
        }),
        skill({
          name: "artifact-template-first",
          path: String.raw`C:\skills\duplicate-name\SKILL.md`,
        }),
        skill({
          name: "artifact-template-path-alias",
          path: String.raw`c:\SKILLS\FIRST\skill.md`,
        }),
        skill({ name: "not-an-artifact-template", path: "/skills/nope" }),
        skill({ name: "artifact-template-disabled", enabled: false }),
      ],
    });
    const env = config?.["mcp_servers.openai_artifact_template_picker"] as {
      env: Record<string, string>;
    };
    const published = JSON.parse(env.env.CODEX_ARTIFACT_TEMPLATE_SKILLS ?? "[]") as Array<{
      skillName: string;
      skillPath: string;
      description: string;
    }>;
    expect(published.map((entry) => entry.skillName)).toEqual([
      "artifact-template-first",
      "vendor:artifact-template-middle",
      "openai-templates:artifact-template-late",
    ]);
    expect(Array.from(published[0]?.description ?? "")).toHaveLength(600);
  });

  test("resolves the checked-in development server and packaged server roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nodex-artifact-template-runtime-"));
    const resources = path.join(root, "resources");
    mkdirSync(path.join(resources, "artifact-template-picker"), { recursive: true });
    writeFileSync(path.join(resources, "artifact-template-picker", "server.mjs"), "export {};\n");
    expect(
      resolveArtifactTemplatePickerRuntime({
        browserNodePath: "/runtime/node",
        isPackaged: false,
        projectRootPath: root,
        resourcesPath: "/unused",
      }),
    ).toEqual({
      nodePath: "/runtime/node",
      serverPath: path.join(resources, "artifact-template-picker", "server.mjs"),
    });
  });
});
