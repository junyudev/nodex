import { useEffect, useEffectEvent, useRef } from "react";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import { contentRoutingContextKey } from "../../../shared/content-routing-context";
import type { PageFileHtmlAdmission } from "../../../shared/page-file-html";
import { cn } from "@/lib/utils";
import { pageFileHtmlAdapter } from "./page-file-html-adapter";

export interface PageFileHtmlViewProps {
  readonly routingContext: ContentRoutingContext;
  readonly pageId: string;
  readonly fileId: string;
  readonly logicalPath: string | null;
  readonly colorScheme: "light" | "dark";
  /** Changing it re-admits and reloads the guest, e.g. when the document's File version or the Page's entries change. */
  readonly reloadKey: string;
  readonly className?: string;
  readonly onStateChange?: (state: {
    readonly status: "loading" | "ready" | "error";
    readonly message?: string;
  }) => void;
}

export function PageFileHtmlView({ reloadKey, ...props }: PageFileHtmlViewProps) {
  const identity = JSON.stringify([
    contentRoutingContextKey(props.routingContext),
    props.pageId,
    props.fileId,
    props.logicalPath,
    props.colorScheme,
    reloadKey,
  ]);
  return <PageFileHtmlGuest key={identity} {...props} />;
}

function PageFileHtmlGuest({
  routingContext,
  pageId,
  fileId,
  logicalPath,
  colorScheme,
  className,
  onStateChange,
}: Omit<PageFileHtmlViewProps, "reloadKey">) {
  const container = useRef<HTMLDivElement>(null);
  const report = useEffectEvent(
    (state: Parameters<NonNullable<PageFileHtmlViewProps["onStateChange"]>>[0]) =>
      onStateChange?.(state),
  );
  const projectId = routingContext.kind === "project" ? routingContext.projectId : null;
  useEffect(() => {
    const parent = container.current;
    if (!parent) return;
    let active = true;
    let admission: PageFileHtmlAdmission | undefined;
    let guest: Electron.WebviewTag | undefined;
    let detach = () => {};
    const release = (grant: string) => {
      void pageFileHtmlAdapter.release(grant).catch(() => {});
    };
    report({ status: "loading" });
    void pageFileHtmlAdapter
      .admit({
        routingContext: projectId === null ? { kind: "library" } : { kind: "project", projectId },
        pageId,
        fileId,
        logicalPath,
        colorScheme,
      })
      .then((result) => {
        if (!active) {
          if (result.status === "admitted") release(result.admission.grant);
          return;
        }
        if (result.status === "refused") {
          report({ status: "error", message: result.message });
          return;
        }
        admission = result.admission;
        guest = document.createElement("webview");
        // The guest sizes its viewport from the element's own box, as other Nodex guests do.
        Object.assign(guest.style, {
          background: "transparent",
          border: "0",
          display: "flex",
          height: "100%",
          minHeight: "0",
          minWidth: "0",
          width: "100%",
        });
        guest.setAttribute("aria-label", "Page File preview");
        // Main denies every popup; this routes target=_blank attempts to its link policy.
        guest.setAttribute("allowpopups", "");
        const ready = () => {
          if (active) report({ status: "ready" });
        };
        const failed = (event: Event) => {
          const failure = event as Event & { isMainFrame?: boolean; errorDescription?: string };
          if (!active || failure.isMainFrame === false) return;
          report({
            status: "error",
            message: failure.errorDescription || "Page File preview could not load",
          });
        };
        guest.addEventListener("did-finish-load", ready);
        guest.addEventListener("did-fail-load", failed);
        guest.addEventListener("render-process-gone", failed);
        detach = () => {
          guest?.removeEventListener("did-finish-load", ready);
          guest?.removeEventListener("did-fail-load", failed);
          guest?.removeEventListener("render-process-gone", failed);
        };
        guest.setAttribute("partition", admission.partition);
        guest.setAttribute("src", admission.url);
        parent.append(guest);
      })
      .catch(() => {
        if (active) report({ status: "error", message: "Page File preview is unavailable" });
      });
    return () => {
      active = false;
      detach();
      guest?.remove();
      if (admission) release(admission.grant);
    };
  }, [projectId, pageId, fileId, logicalPath, colorScheme]);
  return <div ref={container} className={cn("h-full w-full min-h-0 min-w-0", className)} />;
}
