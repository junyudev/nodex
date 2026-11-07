/**
 * Why a remote signal (usage analytics or crash reports) is not leaving this process even though
 * the preference may say it could. Shown beside the setting so the switch never misleads.
 */
export type RemoteSignalBlock = "environment" | "do-not-track" | "ci" | "development-build";

export interface RemoteSignalDecision {
  readonly active: boolean;
  readonly blockedBy: RemoteSignalBlock | null;
}

const isOptOut = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized !== undefined && normalized !== "" && normalized !== "0" && normalized !== "false"
  );
};

/**
 * Both signals default on for people using a released build. An explicit environment override is
 * always respected; otherwise automation, development builds and the conventional opt-out variable
 * keep a machine silent so test and CI runs can never pollute product data.
 */
export const resolveRemoteSignal = (input: {
  readonly preference: boolean;
  readonly override: boolean | null;
  readonly isPackaged: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): RemoteSignalDecision => {
  if (input.override === false) return { active: false, blockedBy: "environment" };
  if (input.override === true) return { active: true, blockedBy: null };
  if (isOptOut(input.environment.DO_NOT_TRACK)) return { active: false, blockedBy: "do-not-track" };
  if (isOptOut(input.environment.CI)) return { active: false, blockedBy: "ci" };
  if (!input.isPackaged) return { active: false, blockedBy: "development-build" };
  return { active: input.preference, blockedBy: null };
};
