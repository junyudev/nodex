import { FloatingFocusManager, useFloatingRootContext } from "@floating-ui/react";
import { useLayoutEffect, type ReactElement } from "react";

interface InertClaim {
  count: number;
  readonly previousAttribute: string | null;
}
const inertClaims = new WeakMap<HTMLElement, InertClaim>();

function acquireInert(element: HTMLElement): () => void {
  const existing = inertClaims.get(element);
  const claim = existing ?? { count: 0, previousAttribute: element.getAttribute("inert") };
  claim.count += 1;
  inertClaims.set(element, claim);
  element.setAttribute("inert", "");
  return () => {
    claim.count -= 1;
    if (claim.count > 0) return;
    inertClaims.delete(element);
    if (claim.previousAttribute === null) element.removeAttribute("inert");
    else element.setAttribute("inert", claim.previousAttribute);
  };
}

function listBackgroundBranches(boundary: HTMLElement): Set<HTMLElement> {
  const branches = new Set<HTMLElement>();
  let current: Element = boundary;
  while (current !== boundary.ownerDocument.body && current.parentElement) {
    const parent = current.parentElement;
    for (const sibling of parent.children) {
      if (sibling === current || !(sibling instanceof HTMLElement)) continue;
      if (sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
      branches.add(sibling);
    }
    current = parent;
  }
  return branches;
}

/** In-place modal content keeps its document and focus guards mounted while owning background inertness. */
export function NodexRetainedModalFocusBoundary({
  open,
  modalElement,
  boundaryElement,
  triggerElement,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly modalElement: HTMLElement | null;
  readonly boundaryElement: HTMLElement | null;
  readonly triggerElement: HTMLElement | null;
  readonly onClose: () => void;
  readonly children: ReactElement;
}) {
  const context = useFloatingRootContext({
    open,
    elements: { reference: triggerElement, floating: modalElement },
    onOpenChange: (next) => {
      if (!next) onClose();
    },
  });
  useLayoutEffect(() => {
    if (!open || !boundaryElement) return;
    const releases = new Map<HTMLElement, () => void>();
    const reconcile = () => {
      const background = listBackgroundBranches(boundaryElement);
      for (const [element, release] of releases) {
        if (background.has(element)) continue;
        release();
        releases.delete(element);
      }
      for (const element of background) {
        if (!releases.has(element)) releases.set(element, acquireInert(element));
      }
    };
    reconcile();
    const observer = new MutationObserver(reconcile);
    observer.observe(boundaryElement.ownerDocument.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      releases.forEach((release) => release());
    };
  }, [open, boundaryElement]);
  return (
    <FloatingFocusManager context={context} disabled={!open} modal returnFocus>
      {children}
    </FloatingFocusManager>
  );
}
