import {
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type RefObject,
} from "react";

import { NodexContextMenuRoot, NodexContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DatabaseViewPageContextMenuOverlay,
  type DatabaseViewPageMenuSession,
} from "./database-view-page-context-menu";

export const DATABASE_VIEW_PAGE_MENU_TARGET_ATTRIBUTE = "data-database-view-page-menu-target";

export interface DatabaseViewPageContextMenuHostProps {
  readonly children: ReactElement;
  readonly resolveSession: (targetKey: string) => DatabaseViewPageMenuSession | null;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Owns one Page context-menu session for an entire Board or List surface.
 * Rows only expose a stable data attribute; they do not mount menu roots or
 * Property editor trees.
 */
export function DatabaseViewPageContextMenuHost({
  children,
  resolveSession,
  returnFocusRef,
}: DatabaseViewPageContextMenuHostProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const session = targetKey ? resolveSession(targetKey) : null;

  const handleMenuOpenChange = (open: boolean): void => {
    setMenuOpen(open);
    if (!open) setTargetKey(null);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLSpanElement>): void => {
    if (!(event.target instanceof Element)) {
      event.stopPropagation();
      return;
    }
    const target = event.target.closest<HTMLElement>(
      `[${DATABASE_VIEW_PAGE_MENU_TARGET_ATTRIBUTE}]`,
    );
    const nextTargetKey = target?.getAttribute(DATABASE_VIEW_PAGE_MENU_TARGET_ATTRIBUTE);
    if (!nextTargetKey || !resolveSession(nextTargetKey)) {
      event.stopPropagation();
      return;
    }
    setTargetKey(nextTargetKey);
  };

  return (
    <NodexContextMenuRoot open={menuOpen} onOpenChange={handleMenuOpenChange}>
      <NodexContextMenuTrigger>
        <span className="contents" data-database-view-page-menu-region="true">
          <span className="contents" onContextMenu={handleContextMenu}>
            {children}
          </span>
        </span>
      </NodexContextMenuTrigger>
      {session ? (
        <DatabaseViewPageContextMenuOverlay
          {...session}
          menuOpen={menuOpen}
          onMenuOpenChange={handleMenuOpenChange}
          returnFocusRef={returnFocusRef}
        />
      ) : null}
    </NodexContextMenuRoot>
  );
}
