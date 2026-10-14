import { useQueryClient } from "@tanstack/react-query";
import type { Project } from "../../../shared/types";
import type { LibraryPageRelocationUndoToken } from "../../../shared/library-module";
import { toast } from "@/components/ui/toast";
import { setInboxEntryState } from "@/lib/inbox-runtime";
import {
  libraryPageRelocationDestinationsQueryOptions,
  useApplyLibraryOperation,
  useUndoLibraryPageRelocation,
} from "@/lib/use-library-navigation";

const DESTINATION_PAGE_SIZE = 100;
const MAX_DESTINATION_PAGES = 5;

/**
 * Moves Inbox message Pages into a Project's primary Database through the same Library
 * relocation the Move-to picker uses, so the move carries ordinary one-shot Undo. Undoing it
 * also returns the message to its Inbox, since filing it was the decision being undone.
 */
export function useMoveInboxPagesToProject() {
  const queryClient = useQueryClient();
  const { mutation } = useApplyLibraryOperation();
  const undoRelocation = useUndoLibraryPageRelocation();

  return async (pageIds: readonly string[], project: Project): Promise<void> => {
    const undoTokens: LibraryPageRelocationUndoToken[] = [];
    const findDestination = async (pageId: string) => {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_DESTINATION_PAGES; page += 1) {
        const destinations = await queryClient.fetchQuery(
          libraryPageRelocationDestinationsQueryOptions(pageId, {
            scope: { kind: "databases" },
            limit: DESTINATION_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          }),
        );
        const entry = destinations.items.find(
          (candidate) =>
            candidate.kind === "database" && candidate.key === `database:${project.databaseId}`,
        );
        if (entry || !destinations.nextCursor) return entry ?? null;
        cursor = destinations.nextCursor;
      }
      return null;
    };
    for (const pageId of pageIds) {
      const entry = await findDestination(pageId);
      if (!entry) throw new Error(`${project.name} is not available as a destination`);
      if (entry.isCurrent) continue;
      const result = await mutation.mutateAsync({
        kind: "move_page",
        pageId,
        destination: entry.destination,
        expectedEtag: entry.expectedMoveEtag,
      });
      const token = result.pageRelocation?.undoToken;
      if (token) undoTokens.push(token);
    }
    const undoToken = undoTokens.length === 1 ? undoTokens[0] : undefined;
    toast.success(`Moved to ${project.name}`, {
      ...(undoToken
        ? {
            action: {
              label: "Undo",
              onClick: () => {
                void undoRelocation(undoToken)
                  .then(() => setInboxEntryState({ pageIds, state: "open" }))
                  .then(() => toast.success("Move undone"))
                  .catch((error: unknown) =>
                    toast.danger(error instanceof Error ? error.message : "Could not undo move"),
                  );
              },
            },
          }
        : {}),
    });
  };
}
