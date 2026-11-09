import type { AgentRuntimeMessageUpload } from "../../shared/agent-runtime-api";
import type { CodexPromptInput } from "../../shared/types";
import { isRemoteSpace } from "./renderer-space";

/**
 * Whether this window's chats run on its Space host. A team Space's chats all do: this Device
 * reaches them only through the operations the host admits, so every surface leaves out, or
 * shows unavailable, whatever the host does not take from a Member's Device.
 */
export const isHostedChat = (): boolean => isRemoteSpace();

/** A path on this computer, as opposed to a Page, chat, app or other link a mention names. */
const isLocalPath = (path: string) =>
  path.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(path) || /^\\\\[^\\]+\\[^\\]+/u.test(path);

/**
 * What a chat on its Space's host receives of a Composer's input. A chat on this computer reads
 * attached and mentioned files at their paths here; the host cannot, so each such file becomes an
 * upload and the words name it instead of its path. Pages, chats, skills and everything else the
 * Composer references stay exactly as written.
 */
export function separateHostedChatUploads(promptInput: CodexPromptInput | undefined): {
  readonly promptInput: CodexPromptInput | undefined;
  readonly uploads: readonly AgentRuntimeMessageUpload[];
} {
  if (!promptInput) return { promptInput, uploads: [] };
  const uploads = new Map<string, AgentRuntimeMessageUpload>();
  const upload = (name: string, path: string) => {
    if (!uploads.has(path)) uploads.set(path, { name, path });
  };
  for (const file of [...(promptInput.fileAttachments ?? []), ...(promptInput.addedFiles ?? [])])
    upload(file.label, file.fsPath || file.path);
  const documentItems = promptInput.documentItems?.map((item) => {
    if (item.type !== "mention" || !isLocalPath(item.path)) return item;
    upload(item.name, item.path);
    return { type: "text" as const, text: item.name };
  });
  const mentions = promptInput.mentions?.filter((mention) => {
    if (!isLocalPath(mention.path)) return true;
    upload(mention.name, mention.path);
    return false;
  });
  if (uploads.size === 0) return { promptInput, uploads: [] };
  const {
    fileAttachments: _attached,
    addedFiles: _added,
    documentItems: _items,
    mentions: _mentions,
    ...rest
  } = promptInput;
  return {
    promptInput: {
      ...rest,
      ...(documentItems ? { documentItems } : {}),
      ...(mentions ? { mentions } : {}),
    },
    uploads: [...uploads.values()],
  };
}
