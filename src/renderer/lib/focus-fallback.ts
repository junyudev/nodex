/**
 * A callback ref for a control that can go away while it has focus, such as an action that ends
 * with its own work. Focus it takes away moves to the fallback instead of dropping to the page.
 */
export const focusFallbackRef =
  (fallback: () => HTMLElement | null | undefined) =>
  (control: HTMLElement | null): (() => void) | undefined => {
    if (!control) return undefined;
    return () => {
      if (control.ownerDocument.activeElement !== control) return;
      // React detaches a ref before it removes the element, so look once the removal is done.
      queueMicrotask(() => {
        const active = control.ownerDocument.activeElement;
        if (control.isConnected || (active !== null && active !== control.ownerDocument.body))
          return;
        fallback()?.focus();
      });
    };
  };
