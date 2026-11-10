import { createContext, useContext } from "react";
import { skillInventoryAdapter } from "@/lib/skill-inventory-adapter";
import type { SkillInventoryContext, SkillInventoryEntry } from "../../../shared/skill-inventory";

type SkillTarget = { readonly skillId: string } | { readonly name: string; readonly path?: string };
export type OpenSkillInput = Partial<SkillInventoryContext> &
  SkillTarget & {
    /** Customize and palette searches choose a destination independently of the retained Scene. */
    readonly destination?: "customize" | "palette";
  };

export const SkillNavigationContext = createContext<{
  readonly open: (input: OpenSkillInput) => Promise<boolean>;
  readonly trySkill: (context: SkillInventoryContext, skill: SkillInventoryEntry) => void;
} | null>(null);

const unavailable = async () => false;
export function useOpenSkill() {
  return useContext(SkillNavigationContext)?.open ?? unavailable;
}

export async function resolveLocalSkill(
  context: SkillInventoryContext,
  target: SkillTarget,
): Promise<SkillInventoryEntry | null> {
  if (context.hostId !== "local") return null;
  const result = await skillInventoryAdapter.list(context).catch(() => null);
  if (result?.status !== "ok") return null;
  const entries = result.value.locations.flatMap((location) => location.skills);
  if ("skillId" in target) return entries.find((skill) => skill.id === target.skillId) ?? null;
  // An explicit path identifies a specific skill even if another folder contains the same name.
  if (target.path) return entries.find((skill) => skill.manifestPath === target.path) ?? null;
  const name = target.name.toLowerCase();
  if (!name) return null;
  const matches = entries.filter((skill) => skill.name.toLowerCase() === name);
  return matches.length === 1 ? matches[0]! : null;
}
