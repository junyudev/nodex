import type { ContentRoutingContext } from "../../shared/content-routing-context";
import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import type { ProjectAppearance } from "../../shared/project-appearance";
import { appScope, scopedAtom, type ScopeHandle } from "./maitai";
import type { BoardSummaryColumn } from "./types";

export interface PageCreateTarget {
  readonly surfaceId: string;
  readonly panelTabId: string;
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly appearance: ProjectAppearance;
  };
  readonly databaseViewId: string;
  readonly clientSessionId: string;
  readonly routingContext: ContentRoutingContext;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly columns: readonly Pick<BoardSummaryColumn, "id" | "name">[];
}

interface PageCreateTargetRegistration {
  readonly token: string;
  readonly target: PageCreateTarget;
}

const pageCreateTargetRegistryAtom = scopedAtom<
  Readonly<Record<string, PageCreateTargetRegistration>>
>(appScope, {}, { debugLabel: "page-create-target-registry" });

export function registerPageCreateTarget(
  appHandle: ScopeHandle,
  token: string,
  target: PageCreateTarget,
): void {
  appHandle.set(pageCreateTargetRegistryAtom, (previous) => ({
    ...previous,
    [target.surfaceId]: { token, target },
  }));
}

export function unregisterPageCreateTarget(
  appHandle: ScopeHandle,
  surfaceId: string,
  token: string,
): void {
  appHandle.set(pageCreateTargetRegistryAtom, (previous) => {
    const existing = previous[surfaceId];
    if (!existing || existing.token !== token) return previous;

    const registrations = { ...previous };
    delete registrations[surfaceId];
    return registrations;
  });
}

export function getPageCreateTarget(
  appHandle: ScopeHandle,
  surfaceId: string,
): PageCreateTarget | null {
  return appHandle.get(pageCreateTargetRegistryAtom)[surfaceId]?.target ?? null;
}
