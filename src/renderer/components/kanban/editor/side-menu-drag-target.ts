import {
  PROJECTION_OWNER_PROP,
  isProjectedCardToggleBlock,
} from "./projection-card-toggle";

interface SideMenuDragTargetBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
}

interface SideMenuDragTargetEditor {
  getBlock: (blockId: string) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asBlock(value: unknown): SideMenuDragTargetBlock | null {
  if (!isRecord(value)) return null;
  return value as SideMenuDragTargetBlock;
}

function toStringProp(props: Record<string, unknown> | undefined, key: string): string {
  const value = props?.[key];
  return typeof value === "string" ? value : "";
}

function resolveProjectedOwnerId(block: SideMenuDragTargetBlock): string {
  if (!isProjectedCardToggleBlock(block)) return "";
  return toStringProp(block.props, PROJECTION_OWNER_PROP);
}

export function resolveCardRefOwnerDragBlock(
  editor: SideMenuDragTargetEditor,
  block: unknown,
): unknown {
  const currentBlock = asBlock(block);
  if (!currentBlock || typeof currentBlock.id !== "string" || currentBlock.id.length === 0) {
    return block;
  }

  const ownerId = resolveProjectedOwnerId(currentBlock);
  if (ownerId.length === 0) return block;

  const owner = asBlock(editor.getBlock(ownerId));
  if (!owner || owner.type !== "cardRef") return block;
  return owner;
}
