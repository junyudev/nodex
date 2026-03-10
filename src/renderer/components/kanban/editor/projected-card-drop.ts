import type { DragSessionBlock } from "./external-block-drag-session";
import {
  PROJECTION_CARD_ID_PROP,
  PROJECTION_OWNER_PROP,
  PROJECTION_SOURCE_PROJECT_PROP,
} from "./projection-card-toggle";

export interface ProjectedCardDropSource {
  ownerBlockId: string;
  sourceProjectId: string;
  sourceCardId: string;
  sourceColumnId?: string;
}

function toStringProp(
  props: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = props?.[key];
  return typeof value === "string" ? value : "";
}

function toBlockProps(block: DragSessionBlock): Record<string, unknown> | undefined {
  if (!block.props || typeof block.props !== "object") {
    return undefined;
  }
  return block.props;
}

export function resolveProjectedCardDropSource(
  block: DragSessionBlock,
): ProjectedCardDropSource | null {
  if (block.type !== "cardToggle") return null;

  const props = toBlockProps(block);
  const ownerBlockId = toStringProp(props, PROJECTION_OWNER_PROP);
  if (!ownerBlockId) return null;

  const sourceProjectId = toStringProp(props, PROJECTION_SOURCE_PROJECT_PROP)
    || toStringProp(props, "sourceProjectId");
  const sourceCardId = toStringProp(props, PROJECTION_CARD_ID_PROP)
    || toStringProp(props, "cardId");
  if (!sourceProjectId || !sourceCardId) return null;

  const sourceColumnId = toStringProp(props, "sourceColumnId");
  return {
    ownerBlockId,
    sourceProjectId,
    sourceCardId,
    sourceColumnId: sourceColumnId.length > 0 ? sourceColumnId : undefined,
  };
}

export function materializeProjectedCardToggleBlock(
  block: DragSessionBlock,
  source: ProjectedCardDropSource,
): Omit<DragSessionBlock, "id"> {
  const props = toBlockProps(block);
  const nextProps: Record<string, unknown> = {
    ...(props ?? {}),
    cardId: source.sourceCardId,
    sourceProjectId: source.sourceProjectId,
  };

  if (source.sourceColumnId) {
    nextProps.sourceColumnId = source.sourceColumnId;
  }

  delete nextProps[PROJECTION_OWNER_PROP];
  delete nextProps[PROJECTION_SOURCE_PROJECT_PROP];
  delete nextProps[PROJECTION_CARD_ID_PROP];
  delete nextProps.projectionKind;

  return {
    type: "cardToggle",
    props: nextProps,
    content: block.content,
    children: block.children,
  };
}
