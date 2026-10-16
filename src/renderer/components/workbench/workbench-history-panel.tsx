import { lazy } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApplicationSurface } from "@/bootstrap/application-surface";
import { libraryMetadataQueryOptions } from "@/lib/use-library-navigation";
import type { HistoryPanelProps } from "../board/history-panel";

const HistoryPanelView = lazy(async () => ({
  default: (await import("../board/history-panel")).HistoryPanel,
}));

export function HistoryPanel(props: Omit<HistoryPanelProps, "fileAuthority">) {
  const metadata = useQuery({ ...libraryMetadataQueryOptions(), enabled: props.open });
  if (!props.open) return null;
  return (
    <ApplicationSurface>
      <HistoryPanelView
        {...props}
        fileAuthority={
          metadata.data
            ? {
                libraryId: metadata.data.libraryId,
                storeEpoch: metadata.data.storeEpoch,
                contentRoutingContext: { kind: "project", projectId: props.projectId },
              }
            : null
        }
      />
    </ApplicationSurface>
  );
}
