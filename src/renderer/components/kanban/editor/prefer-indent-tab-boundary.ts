interface ClosestTargetLike {
  closest: (selector: string) => ClosestTargetLike | null;
  parentElement?: unknown;
}

interface EditorWithPreferIndentBoundary {
  canNestBlock: () => boolean;
  canUnnestBlock: () => boolean;
}

function isClosestTargetLike(value: unknown): value is ClosestTargetLike {
  if (typeof value !== "object" || value === null) return false;
  return "closest" in value && typeof value.closest === "function";
}

function resolveClosestTarget(target: unknown): ClosestTargetLike | null {
  if (isClosestTargetLike(target)) return target;
  if (typeof target !== "object" || target === null) return null;

  const parentElement = "parentElement" in target ? target.parentElement : null;
  return isClosestTargetLike(parentElement) ? parentElement : null;
}

function isInsideEditorContent(target: ClosestTargetLike): boolean {
  return target.closest(".bn-editor") !== null;
}

function allowsSpecializedTabHandling(target: ClosestTargetLike): boolean {
  return target.closest('[data-content-type="codeBlock"], [data-content-type="table"]') !== null;
}

export function shouldSuppressPreferIndentBoundaryTab(
  editor: EditorWithPreferIndentBoundary,
  eventTarget: unknown,
  shiftKey: boolean,
): boolean {
  const target = resolveClosestTarget(eventTarget);
  if (!target || !isInsideEditorContent(target)) return false;
  if (allowsSpecializedTabHandling(target)) return false;

  return shiftKey ? !editor.canUnnestBlock() : !editor.canNestBlock();
}
