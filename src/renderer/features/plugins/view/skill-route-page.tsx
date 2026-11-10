import { ToolbarBreadcrumb } from "@/components/ui/toolbar-breadcrumb";
import { useSkillInventory } from "@/features/skills/skill-inventory";
import { findSkill } from "@/features/skills/skill-presentation";
import { SkillPage } from "@/features/skills/view/skill-page";
import { AppShellHeaderContentRegistrar } from "@/lib/workbench-ui-scopes";
import type { SkillInventoryEntry } from "../../../../shared/skill-inventory";
import type { CustomizeNavigation } from "../customize-navigation";
import { skillTryPrompt } from "../model/skill-model";
import type { PluginContext } from "../plugin-management";
import { buildSkillPath, buildSkillsPath } from "../plugins-routes";

/** The draft that tries a skill in a new chat. */
export function skillEntryTryPrompt(skill: SkillInventoryEntry): string {
  return skillTryPrompt({ name: skill.name, path: skill.manifestPath });
}

/** A skill's page inside Customize: Skills stays selected and leads the titlebar trail. */
export function SkillRoutePage({
  context,
  navigation,
  skillId,
  created,
}: {
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
  readonly skillId: string;
  readonly created: boolean;
}) {
  const inventory = useSkillInventory(context);
  const found = findSkill(
    inventory.data?.status === "ok" ? inventory.data.value : undefined,
    skillId,
  );
  return (
    <>
      <AppShellHeaderContentRegistrar
        content={
          <ToolbarBreadcrumb
            ancestors={[
              {
                id: "skills",
                label: "Skills",
                onSelect: () => navigation.onNavigate(buildSkillsPath()),
              },
            ]}
            current={found?.skill.name}
          />
        }
      />
      <SkillPage
        key={skillId}
        context={context}
        skillId={skillId}
        autoFocusName={created}
        onOpenSkill={(next) => navigation.onNavigate(buildSkillPath(next), { replace: true })}
        onClose={() => navigation.onNavigate(buildSkillsPath(), { replace: true })}
        onTry={(skill) => navigation.onStartChat(skillEntryTryPrompt(skill))}
      />
    </>
  );
}
