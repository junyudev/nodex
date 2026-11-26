import { lazy } from "react";
import { ApplicationSurface } from "@/bootstrap/application-surface";
import type { HistoryPanelProps } from "../board/history-panel";

const HistoryPanelView = lazy(async () => ({
  default: (await import("../board/history-panel")).HistoryPanel,
}));

export function HistoryPanel(props: Omit<HistoryPanelProps, "fileAuthority">) {
  if (!props.open) return null;
  return (
    <ApplicationSurface>
      <HistoryPanelView
        {...props}
        fileAuthority={{
          libraryId: props.descriptor.libraryId,
          storeEpoch: props.descriptor.storeEpoch,
          contentRoutingContext: props.descriptor.routingContext,
        }}
      />
    </ApplicationSurface>
  );
}
