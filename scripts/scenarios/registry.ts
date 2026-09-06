import { agentCliWorkflowScenario } from "./scenarios/agent-cli-workflow";
import { documentSyncRecoveryScenario } from "./scenarios/document-sync-recovery";
import type { ScenarioDomainRecipe } from "./contracts";
import { boardDenseScenario } from "./scenarios/board-dense";
import { databaseContextMenuPerformanceScenario } from "./scenarios/database-context-menu-performance";
import { databaseSettingsConfigurationScenario } from "./scenarios/database-settings-configuration";
import { pageRelocationScenario } from "./scenarios/page-relocation";
import { nfmCodeBlockActionsScenario } from "./scenarios/nfm-code-block-actions";
import { nfmEquationAndMermaidScenario } from "./scenarios/nfm-equation-and-mermaid";
import { pageRelatedChatActivityScenario } from "./scenarios/page-related-chat-activity";
import { sidebarCustomSectionsScenario } from "./scenarios/sidebar-custom-sections";
import { libraryFilesScenario } from "./scenarios/library-files";

const scenarios = new Map<string, ScenarioDomainRecipe>([
  [agentCliWorkflowScenario.id, agentCliWorkflowScenario],
  [documentSyncRecoveryScenario.id, documentSyncRecoveryScenario],
  [boardDenseScenario.id, boardDenseScenario],
  [databaseContextMenuPerformanceScenario.id, databaseContextMenuPerformanceScenario],
  [databaseSettingsConfigurationScenario.id, databaseSettingsConfigurationScenario],
  [pageRelocationScenario.id, pageRelocationScenario],
  [pageRelatedChatActivityScenario.id, pageRelatedChatActivityScenario],
  [nfmCodeBlockActionsScenario.id, nfmCodeBlockActionsScenario],
  [nfmEquationAndMermaidScenario.id, nfmEquationAndMermaidScenario],
  [sidebarCustomSectionsScenario.id, sidebarCustomSectionsScenario],
  [libraryFilesScenario.id, libraryFilesScenario],
]);

export const listScenarioIds = (): readonly string[] => [...scenarios.keys()];

export const getScenario = (scenarioId: string): ScenarioDomainRecipe => {
  const scenario = scenarios.get(scenarioId);
  if (scenario) return scenario;
  throw new Error(
    `Unknown scenario ${scenarioId}. Available scenarios: ${listScenarioIds().join(", ")}`,
  );
};
