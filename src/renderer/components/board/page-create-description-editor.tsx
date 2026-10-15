import type { RefObject } from "react";
import { libraryContentRoute } from "../../../shared/content-routing-context";
import type { PageCreateDescriptionDraft } from "@/lib/page-create-draft";
import { PAGE_DESCRIPTION_PLACEHOLDER } from "@/lib/page-description-placeholder";
import { NfmEditor, type NfmEditorBoundaryHandle } from "./editor/nfm-editor";

interface PageCreateDescriptionEditorProps {
  readonly draft: PageCreateDescriptionDraft;
  readonly navigationRef: RefObject<NfmEditorBoundaryHandle | null>;
  readonly titleInputRef: RefObject<HTMLInputElement | null>;
}

export function PageCreateDescriptionEditor({
  draft,
  navigationRef,
  titleInputRef,
}: PageCreateDescriptionEditorProps) {
  return (
    <NfmEditor
      contentRoutingContext={libraryContentRoute}
      isActivePanelTab={false}
      placeholder={PAGE_DESCRIPTION_PLACEHOLDER}
      className="min-h-[inherit] [&_.bn-block-content]:!px-0"
      source={{
        kind: "collaborative-document",
        documentId: draft.documentId,
        storeEpoch: "page-create-draft",
        generation: draft.generation,
        clientSessionId: draft.clientSessionId,
        fragment: draft.body,
        user: {
          name: "You",
          color: "#0285ff",
        },
      }}
      embeddedBoundary={{
        navigationRef,
        onBoundaryArrow: (direction) => {
          if (direction !== "up") return false;
          titleInputRef.current?.focus();
          return true;
        },
      }}
    />
  );
}
