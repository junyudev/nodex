import { Plugin, PluginKey } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";
import type * as Y from "yjs";
import {
  createExtension,
  type ExtensionOptions,
} from "../../editor/BlockNoteExtension.js";

const activeSurfaceOrigins = new WeakMap<Y.Doc, object>();
const registeredDocuments = new WeakSet<Y.Doc>();

const registerDocumentOriginRetagger = (document: Y.Doc): void => {
  if (registeredDocuments.has(document)) return;
  registeredDocuments.add(document);
  document.on("beforeTransaction", (transaction) => {
    if (transaction.origin !== ySyncPluginKey) return;
    const origin = activeSurfaceOrigins.get(document);
    if (!origin) return;
    (transaction as { origin: unknown }).origin = origin;
  });
};

interface SurfaceOriginOptions {
  readonly fragment: Y.XmlFragment;
  readonly transactionOrigin: object;
}

/** Tags y-prosemirror writes with the EditorSurface that produced them. */
export const YSurfaceOriginExtension = createExtension(
  ({ options }: ExtensionOptions<SurfaceOriginOptions>) => {
    const document = options.fragment.doc;
    if (!document) {
      throw new Error("Collaborative surface origin requires an attached Y.Doc");
    }
    registerDocumentOriginRetagger(document);
    const pluginKey = new PluginKey<boolean>("ySurfaceOrigin");
    const plugin = new Plugin<boolean>({
      key: pluginKey,
      state: {
        init: () => false,
        apply: (transaction, previous) => {
          const metadata = transaction.getMeta(ySyncPluginKey) as
            | { readonly isChangeOrigin?: boolean }
            | undefined;
          if (transaction.docChanged) return metadata?.isChangeOrigin !== true;
          // A view update follows the entire appended-transaction batch. A
          // selection-only append (such as selecting dropped Blocks) must not
          // erase the writer of the document edit that YSync will publish.
          return (
            transaction.getMeta("appendedTransaction") !== undefined && previous
          );
        },
      },
      view: (view) => ({
        update: () => {
          if (pluginKey.getState(view.state) !== true) return;
          activeSurfaceOrigins.set(document, options.transactionOrigin);
        },
      }),
    });
    return {
      key: "ySurfaceOrigin",
      prosemirrorPlugins: [plugin],
      runsBefore: ["ySync"],
    } as const;
  },
);
