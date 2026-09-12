import { existsSync } from "node:fs";
import path from "node:path";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import type { SkillsListResponse } from "@nodex/codex-app-server-protocol/v2/SkillsListResponse";
import type { ThreadStartParams } from "@nodex/codex-app-server-protocol/v2/ThreadStartParams";

const MAX_ARTIFACT_TEMPLATE_SKILLS = 100;
const MAX_ARTIFACT_TEMPLATE_SKILLS_ENV_BYTES = 24_000;
const MAX_ARTIFACT_TEMPLATE_DESCRIPTION_CODE_POINTS = 600;
const ARTIFACT_TEMPLATE_SKILL_PATTERN = /^(?:[^:]+:)?artifact-template-[a-z0-9][a-z0-9._-]*$/u;

type ThreadConfig = NonNullable<ThreadStartParams["config"]>;

export interface ArtifactTemplatePickerRuntime {
  readonly nodePath: string;
  readonly serverPath: string;
}

const priority = (name: string): number =>
  name.includes(":") ? (name.startsWith("openai-templates:") ? 2 : 1) : 0;

const description = (skill: SkillMetadata): string =>
  Array.from(
    skill.description.trim() ||
      skill.interface?.shortDescription?.trim() ||
      skill.interface?.displayName?.trim() ||
      skill.name,
  )
    .slice(0, MAX_ARTIFACT_TEMPLATE_DESCRIPTION_CODE_POINTS)
    .join("");

export function buildArtifactTemplatePickerConfig(input: {
  readonly runtime: ArtifactTemplatePickerRuntime;
  readonly skills?: readonly SkillMetadata[] | null;
  readonly platform?: NodeJS.Platform;
  readonly shouldUseWslPaths?: boolean;
}): ThreadConfig | null {
  if (input.shouldUseWslPaths) return null;
  if (!input.runtime.nodePath || !existsSync(input.runtime.serverPath)) return null;

  const env: Record<string, string> = {};
  if (input.skills !== undefined && input.skills !== null) {
    const sorted = input.skills
      .filter((skill) => skill.enabled && ARTIFACT_TEMPLATE_SKILL_PATTERN.test(skill.name))
      .sort((left, right) => priority(left.name) - priority(right.name));
    const selected: Array<{
      skillName: string;
      skillPath: string;
      description: string;
    }> = [];
    const names = new Set<string>();
    const paths = new Set<string>();
    let encodedBytes = 2;

    for (const skill of sorted) {
      const skillPath = String(skill.path);
      const comparablePath =
        (input.platform ?? process.platform) === "win32" ? skillPath.toLowerCase() : skillPath;
      if (
        names.has(skill.name) ||
        paths.has(comparablePath) ||
        selected.length === MAX_ARTIFACT_TEMPLATE_SKILLS
      )
        continue;

      const candidate = {
        skillName: skill.name,
        skillPath,
        description: description(skill),
      };
      const candidateBytes =
        Buffer.byteLength(JSON.stringify(candidate), "utf8") + Number(selected.length > 0);
      if (encodedBytes + candidateBytes > MAX_ARTIFACT_TEMPLATE_SKILLS_ENV_BYTES) continue;

      selected.push(candidate);
      names.add(skill.name);
      paths.add(comparablePath);
      encodedBytes += candidateBytes;
    }
    if (selected.length > 0) env.CODEX_ARTIFACT_TEMPLATE_SKILLS = JSON.stringify(selected);
  }

  return {
    "mcp_servers.openai_artifact_template_picker": {
      command: input.runtime.nodePath,
      args: [input.runtime.serverPath],
      env,
    },
  };
}

export const flattenArtifactTemplateSkills = (
  response: SkillsListResponse,
): readonly SkillMetadata[] => response.data.flatMap((entry) => entry.skills);

export const resolveArtifactTemplatePickerRuntime = (input: {
  readonly browserNodePath: string | null;
  readonly isPackaged: boolean;
  readonly projectRootPath: string;
  readonly resourcesPath: string;
}): ArtifactTemplatePickerRuntime | null => {
  if (!input.browserNodePath) return null;
  const resourcesRoot = input.isPackaged
    ? input.resourcesPath
    : path.join(input.projectRootPath, "resources");
  const serverPath = path.join(resourcesRoot, "artifact-template-picker", "server.mjs");
  if (!existsSync(serverPath)) return null;
  return { nodePath: input.browserNodePath, serverPath };
};
