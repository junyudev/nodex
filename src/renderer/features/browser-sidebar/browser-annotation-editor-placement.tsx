import { placeBrowserAnnotationEditor } from "./browser-annotation-editor-position";
import { useLayoutEffect, useState, useRef, type ReactNode } from "react";
import type { BrowserAnnotationAnchor } from "../../../shared/browser-annotation";
import type { BrowserSidebarTabIdentity } from "../../../shared/browser-sidebar";
import { useBrowserPageOverlayHost } from "./browser-page-overlay";

export function BrowserAnnotationEditorPlacement({
  identity,
  anchor,
  children,
}: {
  identity: BrowserSidebarTabIdentity;
  anchor?: BrowserAnnotationAnchor;
  children: ReactNode;
}) {
  const host = useBrowserPageOverlayHost(identity);
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<ReturnType<typeof placeBrowserAnnotationEditor>>();
  useLayoutEffect(() => {
    const editor = ref.current;
    if (!host || !editor || !anchor) return;
    const update = () => {
      const zoom =
        Number(getComputedStyle(editor).zoom) ||
        Number(getComputedStyle(editor.parentElement!).zoom) ||
        1;
      const width = host.clientWidth / zoom;
      const height = host.clientHeight / zoom;
      const scaleX = width / (anchor.viewportSize?.width ?? width);
      const scaleY = height / (anchor.viewportSize?.height ?? height);
      setStyle(
        placeBrowserAnnotationEditor(
          {
            x: anchor.rect.x * scaleX,
            y: anchor.rect.y * scaleY,
            width: anchor.rect.width * scaleX,
            height: anchor.rect.height * scaleY,
          },
          { width, height },
          { width: editor.offsetWidth, height: editor.offsetHeight },
        ),
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(host);
    observer.observe(editor);
    update();
    return () => observer.disconnect();
  }, [anchor, host]);
  if (!anchor) return children;
  return (
    <div ref={ref} className="absolute w-[22rem] overflow-y-auto" style={style}>
      {children}
    </div>
  );
}
