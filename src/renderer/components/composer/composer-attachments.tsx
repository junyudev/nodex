import type { ReactNode } from "react";

/**
 * The row above a composer's text. Its inset holds while it is empty, which sets where the text
 * starts, and gives what it holds a corner radius nested inside the composer's.
 */
export function ComposerAttachments({ children }: { readonly children?: ReactNode }) {
  return (
    <div className="composer-attachments" data-composer-attachments="true">
      {children}
    </div>
  );
}

/** Attachments on one line, which scrolls sideways once they outgrow the composer. */
export function ComposerAttachmentStrip({ children }: { readonly children: ReactNode }) {
  return (
    <div className="hide-scrollbar w-full overflow-x-auto p-px">
      <div className="flex min-w-max items-end gap-2">{children}</div>
    </div>
  );
}
