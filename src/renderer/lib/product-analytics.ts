import type { RendererProductEvent } from "../../shared/product-analytics/catalog";
import { getWorkbenchPanelActiveLeaf } from "../../shared/workbench-panel-layout";
import type { WorkbenchSceneSnapshot, WorkbenchSurfaceKind } from "../../shared/workbench-scene";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const recordCommand = defineRendererCommand({
  key: "product_analytics.record",
  channel: "product-analytics:record",
  authority: "main",
  owner: "ProductAnalytics",
  protocol: { kind: "returned_value" },
});

/** Hand an event to Main, which alone decides whether it is reported. Never affects the caller. */
export function recordProductEvent(event: RendererProductEvent): void {
  try {
    void invokePlainCommand(recordCommand, event).catch(() => undefined);
  } catch {
    // Analytics has no user-visible failure mode.
  }
}

type Feature = Extract<RendererProductEvent, { name: "feature_used" }>["properties"]["feature"];
const reportedFeatures = new Set<Feature>();

/** Adoption, not volume: each surface reports once per window session. */
export function recordFeatureUsed(feature: Feature): void {
  if (reportedFeatures.has(feature)) return;
  reportedFeatures.add(feature);
  recordProductEvent({ name: "feature_used", properties: { feature } });
}

const FEATURE_OF_SURFACE: Partial<Record<WorkbenchSurfaceKind, Feature>> = {
  browser: "browser",
  canvas_stage: "canvas",
  db_view: "database",
  inbox: "inbox",
  page_stage: "page",
  review: "review",
  terminal: "terminal",
};

/** Adoption counts what a person is looking at, not tabs a window opens by default. */
export function recordPresentedSurfaces(scene: WorkbenchSceneSnapshot | null): void {
  if (!scene) return;
  for (const panel of Object.values(scene.panels)) {
    if (panel.collapsed) continue;
    const { activeTabId } = getWorkbenchPanelActiveLeaf(panel.layout);
    const surface =
      activeTabId === scene.primary?.id
        ? scene.primary
        : scene.panelSurfacesById[activeTabId ?? ""];
    const feature = surface && FEATURE_OF_SURFACE[surface.kind];
    if (feature) recordFeatureUsed(feature);
  }
}

export function resetReportedFeaturesForTests(): void {
  reportedFeatures.clear();
}

const noticePresentedCommand = defineRendererCommand({
  key: "product_analytics.notice_presented",
  channel: "product-analytics:notice:presented",
  authority: "main",
  owner: "ProductAnalytics",
  protocol: { kind: "returned_value" },
});

const noticeAcknowledgedCommand = defineRendererCommand({
  key: "product_analytics.notice_acknowledged",
  channel: "product-analytics:notice:acknowledge",
  authority: "main",
  owner: "ProductAnalytics",
  protocol: { kind: "returned_value" },
});

export const readProductAnalyticsNotice = () =>
  invokeRendererQuery("product-analytics:notice:read");
export const markProductAnalyticsNoticePresented = () => invokePlainCommand(noticePresentedCommand);
export const acknowledgeProductAnalyticsNotice = () =>
  invokePlainCommand(noticeAcknowledgedCommand);
export const readProductAnalyticsActivity = () =>
  invokeRendererQuery("product-analytics:activity:read");
