import { automationEventsScenario } from "./scenarios/automation-events";
import { nodexCoordinationScenario, releaseCaptureScenario } from "./scenarios/nodex-coordination";
import {
  structuralInteractionsScenario,
  structuralInteractionsPressureScenario,
} from "./scenarios/structural-interactions";
import { agentCliWorkflowScenario } from "./scenarios/agent-cli-workflow";
import { agentCrossProviderDelegationScenario } from "./scenarios/agent-cross-provider-delegation";
import { landingSharedPagesScenario, landingShowcaseScenario } from "./scenarios/landing-showcase";
import { documentRecoveryReviewScenario } from "./scenarios/document-recovery-review";
import { documentSyncRecoveryScenario } from "./scenarios/document-sync-recovery";
import type { ScenarioDomainRecipe } from "./contracts";
import { boardDenseScenario } from "./scenarios/board-dense";
import { databaseContextMenuPerformanceScenario } from "./scenarios/database-context-menu-performance";
import { databaseSettingsConfigurationScenario } from "./scenarios/database-settings-configuration";
import { pageRelocationScenario } from "./scenarios/page-relocation";
import { nfmCodeBlockActionsScenario } from "./scenarios/nfm-code-block-actions";
import { nfmEquationAndMermaidScenario } from "./scenarios/nfm-equation-and-mermaid";
import { nfmTablesScenario } from "./scenarios/nfm-tables";
import { pageRelatedChatActivityScenario } from "./scenarios/page-related-chat-activity";
import { sidebarCustomSectionsScenario } from "./scenarios/sidebar-custom-sections";
import { sidebarAttentionScenario } from "./scenarios/sidebar-attention";
import { sidebarChatStatusScenario } from "./scenarios/sidebar-chat-status";
import { sidebarPaginationScenario } from "./scenarios/sidebar-pagination";
import { sidebarSettledHistoryScenario } from "./scenarios/sidebar-settled-history";
import { sidebarLinkedPageStatusScenario } from "./scenarios/sidebar-linked-page-status";
import { libraryFilesScenario } from "./scenarios/library-files";
import { libraryLocationsScenario } from "./scenarios/library-locations";
import { pageFileProvenanceScenario } from "./scenarios/page-file-provenance";
import { inboxTriageScenario } from "./scenarios/inbox-triage";
import { inboxSuggestionSpendScenario } from "./scenarios/inbox-suggestion-spend";
import { automationsAskInInboxScenario } from "./scenarios/automations-ask-in-inbox";
import { spaceContentScenario } from "./scenarios/space-content";
import { skillsPagesScenario } from "./scenarios/skills-pages";
import { windowTitlesScenario } from "./scenarios/window-titles";

const scenarios = new Map<string, ScenarioDomainRecipe>([
  [automationEventsScenario.id, automationEventsScenario],
  [nodexCoordinationScenario.id, nodexCoordinationScenario],
  [releaseCaptureScenario.id, releaseCaptureScenario],
  [structuralInteractionsScenario.id, structuralInteractionsScenario],
  [structuralInteractionsPressureScenario.id, structuralInteractionsPressureScenario],
  [landingShowcaseScenario.id, landingShowcaseScenario],
  [landingSharedPagesScenario.id, landingSharedPagesScenario],
  [agentCliWorkflowScenario.id, agentCliWorkflowScenario],
  [agentCrossProviderDelegationScenario.id, agentCrossProviderDelegationScenario],
  [documentSyncRecoveryScenario.id, documentSyncRecoveryScenario],
  [documentRecoveryReviewScenario.id, documentRecoveryReviewScenario],
  [boardDenseScenario.id, boardDenseScenario],
  [databaseContextMenuPerformanceScenario.id, databaseContextMenuPerformanceScenario],
  [databaseSettingsConfigurationScenario.id, databaseSettingsConfigurationScenario],
  [pageRelocationScenario.id, pageRelocationScenario],
  [pageRelatedChatActivityScenario.id, pageRelatedChatActivityScenario],
  [nfmCodeBlockActionsScenario.id, nfmCodeBlockActionsScenario],
  [nfmEquationAndMermaidScenario.id, nfmEquationAndMermaidScenario],
  [nfmTablesScenario.id, nfmTablesScenario],
  [sidebarCustomSectionsScenario.id, sidebarCustomSectionsScenario],
  [sidebarAttentionScenario.id, sidebarAttentionScenario],
  [sidebarChatStatusScenario.id, sidebarChatStatusScenario],
  [sidebarPaginationScenario.id, sidebarPaginationScenario],
  [sidebarSettledHistoryScenario.id, sidebarSettledHistoryScenario],
  [sidebarLinkedPageStatusScenario.id, sidebarLinkedPageStatusScenario],
  [libraryFilesScenario.id, libraryFilesScenario],
  [libraryLocationsScenario.id, libraryLocationsScenario],
  [pageFileProvenanceScenario.id, pageFileProvenanceScenario],
  [inboxTriageScenario.id, inboxTriageScenario],
  [automationsAskInInboxScenario.id, automationsAskInInboxScenario],
  [inboxSuggestionSpendScenario.id, inboxSuggestionSpendScenario],
  [spaceContentScenario.id, spaceContentScenario],
  [windowTitlesScenario.id, windowTitlesScenario],
  [skillsPagesScenario.id, skillsPagesScenario],
]);

export const listScenarioIds = (): readonly string[] => [...scenarios.keys()];

export const getScenario = (scenarioId: string): ScenarioDomainRecipe => {
  const scenario = scenarios.get(scenarioId);
  if (scenario) return scenario;
  throw new Error(
    `Unknown scenario ${scenarioId}. Available scenarios: ${listScenarioIds().join(", ")}`,
  );
};
