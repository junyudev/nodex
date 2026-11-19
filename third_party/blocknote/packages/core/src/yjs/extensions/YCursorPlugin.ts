import { defaultSelectionBuilder, yCursorPlugin } from "y-prosemirror";
import {
  createExtension,
  ExtensionOptions,
} from "../../editor/BlockNoteExtension.js";
import type { CollaborationOptions } from "./index.js";

export type CollaborationUser = {
  id?: string;
  name: string;
  color: string;
  [key: string]: unknown;
};

/**
 * Determine whether the foreground color should be white or black based on a provided background color
 * Inspired by: https://stackoverflow.com/a/3943023
 */
function isDarkColor(bgColor: string): boolean {
  const color = bgColor.charAt(0) === "#" ? bgColor.substring(1, 7) : bgColor;
  const r = parseInt(color.substring(0, 2), 16); // hexToR
  const g = parseInt(color.substring(2, 4), 16); // hexToG
  const b = parseInt(color.substring(4, 6), 16); // hexToB
  const uicolors = [r / 255, g / 255, b / 255];
  const c = uicolors.map((col) => {
    if (col <= 0.03928) {
      return col / 12.92;
    }
    return Math.pow((col + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return L <= 0.179;
}

function defaultCursorRender(user: CollaborationUser) {
  const cursorElement = document.createElement("span");

  cursorElement.classList.add("bn-collaboration-cursor__base");

  const caretElement = document.createElement("span");
  caretElement.setAttribute("contentedEditable", "false");
  caretElement.classList.add("bn-collaboration-cursor__caret");

  const labelElement = document.createElement("span");

  labelElement.classList.add("bn-collaboration-cursor__label");
  caretElement.insertBefore(labelElement, null);

  cursorElement.insertBefore(document.createTextNode("\u2060"), null); // Non-breaking space
  cursorElement.insertBefore(caretElement, null);
  cursorElement.insertBefore(document.createTextNode("\u2060"), null); // Non-breaking space

  let name: string | undefined;
  let color: string | undefined;
  const updateUser = (next: CollaborationUser) => {
    if (next.name !== name) {
      name = next.name;
      labelElement.textContent = name;
    }
    if (next.color !== color) {
      color = next.color;
      const style = `background-color: ${color}; color: ${isDarkColor(color) ? "white" : "black"}`;
      caretElement.setAttribute("style", style);
      labelElement.setAttribute("style", style);
    }
  };
  updateUser(user);
  return { element: cursorElement, updateUser };
}

type RenderedCursor = {
  element: HTMLElement;
  updateUser?: (user: CollaborationUser) => void;
  hideTimeout: ReturnType<typeof setTimeout> | undefined;
};

export const YCursorExtension = createExtension(
  ({ options }: ExtensionOptions<CollaborationOptions>) => {
    const recentlyUpdatedCursors = new Map<number, RenderedCursor>();
    const awareness =
      options.provider &&
      "awareness" in options.provider &&
      typeof options.provider.awareness === "object"
        ? options.provider.awareness
        : undefined;
    if (awareness) {
      if (
        options.user &&
        "setLocalStateField" in awareness &&
        typeof awareness.setLocalStateField === "function"
      ) {
        awareness.setLocalStateField("user", options.user);
      }
    }

    const handleAwarenessChange = ({
      added,
      updated,
    }: {
      added: Array<number>;
      updated: Array<number>;
      removed: Array<number>;
    }) => {
      for (const clientID of [...added, ...updated]) {
        const cursor = recentlyUpdatedCursors.get(clientID);
        if (!cursor) continue;
        const user = awareness?.getStates().get(clientID)?.user as CollaborationUser | undefined;
        if (user?.name && user.color) cursor.updateUser?.(user);

        if (options.showCursorLabels === "always" || !updated.includes(clientID)) continue;
        setTimeout(() => {
          cursor.element.setAttribute("data-active", "");
        }, 10);
        clearTimeout(cursor.hideTimeout);
        cursor.hideTimeout = setTimeout(() => {
          cursor.element.removeAttribute("data-active");
        }, 2000);
      }
    };

    return {
      key: "yCursor",
      mount() {
        if (
          awareness &&
          "on" in awareness &&
          typeof awareness.on === "function"
        ) {
          awareness.on("change", handleAwarenessChange);

          return () => {
            if ("off" in awareness && typeof awareness.off === "function") {
              awareness.off("change", handleAwarenessChange);
            }
          };
        }

        return undefined;
      },
      prosemirrorPlugins: [
        awareness
          ? yCursorPlugin(awareness, {
              selectionBuilder: defaultSelectionBuilder,
              cursorBuilder(user: CollaborationUser, clientID: number) {
                let cursorData = recentlyUpdatedCursors.get(clientID);

                if (!cursorData) {
                  const rendered = options.renderCursor
                    ? { element: options.renderCursor(user) }
                    : defaultCursorRender(user);
                  const cursorElement = rendered.element;

                  if (options.showCursorLabels !== "always") {
                    cursorElement.addEventListener("mouseenter", () => {
                      const cursor = recentlyUpdatedCursors.get(clientID)!;
                      cursor.element.setAttribute("data-active", "");

                      if (cursor.hideTimeout) {
                        clearTimeout(cursor.hideTimeout);
                        cursor.hideTimeout = undefined;
                      }
                    });

                    cursorElement.addEventListener("mouseleave", () => {
                      const cursor = recentlyUpdatedCursors.get(clientID)!;

                      cursor.hideTimeout = setTimeout(() => {
                        cursor.element.removeAttribute("data-active");
                      }, 2000);
                    });
                  }

                  cursorData = {
                    ...rendered,
                    hideTimeout: undefined,
                  };

                  recentlyUpdatedCursors.set(clientID, cursorData);
                }

                return cursorData.element;
              },
            })
          : undefined,
      ].filter(Boolean),
      dependsOn: ["ySync"],
      updateUser(user: { name: string; color: string; [key: string]: string }) {
        awareness?.setLocalStateField("user", user);
      },
      getUser(): CollaborationUser | undefined {
        const state = awareness?.getLocalState();
        if (!state) {
          return undefined;
        }
        return state["user"];
      },
    } as const;
  },
);
