import { useLayoutEffect, useRef, useState } from "react";
import {
  createPageCreateDescriptionDraft,
  materializePageCreateDescription,
  type PageCreateDescriptionDraft,
} from "./page-create-draft";

/** The form retains portable content; each mounted view owns its live Document. */
export function usePageCreateDescriptionDraft(requestId: string, initialNfm = "") {
  const [generation, setGeneration] = useState(0);
  const [draft, setDraft] = useState<PageCreateDescriptionDraft | null>(null);
  const snapshot = useRef({ requestId, generation: 0, markdown: initialNfm });

  useLayoutEffect(() => {
    const retained = snapshot.current;
    const markdown =
      retained.requestId === requestId && retained.generation === generation
        ? retained.markdown
        : "";
    const current = createPageCreateDescriptionDraft(requestId, generation, markdown);
    setDraft(current);
    return () => {
      try {
        snapshot.current = {
          requestId,
          generation,
          markdown: materializePageCreateDescription(current),
        };
      } catch (error) {
        // Closing a malformed draft must still release its live Document. The
        // form's explicit close action already reports snapshot failures.
        console.error("[page-create:view-snapshot]", error);
      } finally {
        current.document.destroy();
      }
    };
  }, [generation, requestId]);

  return {
    draft: draft && !draft.document.isDestroyed ? draft : null,
    reset: () => setGeneration((current) => current + 1),
  };
}
