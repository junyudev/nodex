export const OFFICIAL_AGENT_SKILL_FILES: readonly string[];
export const OFFICIAL_AGENT_SKILLS_ARTIFACT_FILES: readonly string[];

export interface InspectedOfficialAgentSkillsArtifact {
  readonly manifest: {
    readonly schemaVersion: 1;
    readonly distribution: "NodexApp/skills";
    readonly product: {
      readonly name: "Nodex";
      readonly releaseVersion: string;
    };
    readonly source: {
      readonly repository: string;
      readonly ref: string;
    };
    readonly agentInterface: {
      readonly minimumRevision: 1;
      readonly maximumRevision: 1;
    };
    readonly skills: readonly [
      {
        readonly name: "nodex";
        readonly path: "skills/nodex";
        readonly treeSha256: string;
        readonly fileCount: number;
        readonly totalBytes: number;
      },
    ];
  };
  readonly manifestSha256: string;
  readonly releaseVersion: string;
  readonly sourceRef: string;
  readonly sourceRepository: string;
  readonly treeSha256: string;
}

export function inspectOfficialAgentSkillsArtifact(
  artifactRoot: string,
): InspectedOfficialAgentSkillsArtifact;

export function inspectHistoricalOfficialAgentSkillsArtifact(
  artifactRoot: string,
  skillFiles: readonly string[],
): InspectedOfficialAgentSkillsArtifact;
