import type { ImageEditComposerTarget } from "@/lib/content-image";

/**
 * Derives the runtime-only image editing route from the stable ThreadScope.
 * The scope path survives a New Chat's promotion to a real task, while the
 * placement suffix keeps root and side composers isolated.
 */
export function resolveImageEditComposerTarget(input: {
  readonly composerScopeIdentity?: string | null;
  readonly isSideChat: boolean;
  readonly threadScopePath: string;
}): ImageEditComposerTarget {
  const sideIdentity = input.composerScopeIdentity?.trim();
  const placement =
    input.isSideChat || sideIdentity?.startsWith("side-chat:") === true ? "side" : "root";

  return {
    channelId: `${input.threadScopePath}::${
      placement === "root" ? "root" : sideIdentity || "side"
    }`,
    placement,
  };
}
