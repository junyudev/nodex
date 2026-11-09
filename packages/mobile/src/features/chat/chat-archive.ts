import { setChatArchived } from "../../runtime";
import { lightTap } from "../../ui/primitives";
import { showFailure, showSnack } from "../../ui/snackbar";

/**
 * Archives or restores a chat the reader may manage, then offers to take it back. Core refuses
 * anyone else, so a chat whose owner changed meanwhile says why.
 */
export const setArchived = (sessionId: string, archived: boolean): void => {
  lightTap();
  setChatArchived(sessionId, archived).then(
    () =>
      showSnack({
        text: archived ? "Chat archived" : "Chat restored",
        action: { label: "Undo", run: () => setArchived(sessionId, !archived) },
      }),
    (cause: unknown) =>
      showFailure(archived ? "The chat wasn't archived" : "The chat wasn't restored", cause),
  );
};
