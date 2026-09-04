import { useQuery } from "@tanstack/react-query";
import { libraryMetadataQueryOptions } from "@/lib/use-library-navigation";
import { HistoryPanel as HistoryPanelView, type HistoryPanelProps } from "../board/history-panel";

export function HistoryPanel(props: Omit<HistoryPanelProps, "fileAuthority">) {
  const metadata = useQuery({ ...libraryMetadataQueryOptions(), enabled: props.open });
  return (
    <HistoryPanelView
      {...props}
      fileAuthority={
        metadata.data
          ? {
              libraryId: metadata.data.libraryId,
              storeEpoch: metadata.data.storeEpoch,
              contentAccessContext: { kind: "project", projectId: props.projectId },
            }
          : null
      }
    />
  );
}
