import { useId, useMemo, useState } from "react";
import { MarkdownRenderer } from "./markdown/markdown-renderer";
import { cn } from "../../../lib/utils";
import {
  CopyMessageActionButton,
  ThreadActionIconButton,
} from "./thread-message-actions";

const COLLAPSED_PLAN_MAX_HEIGHT_PX = 320;

function resolvePlanDownloadFilename(content: string): string {
  const normalized = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "plan";

  const titleSource = normalized
    .replace(/^#+\s*/, "")
    .replace(/^title:\s*/i, "")
    .trim();

  const slug = titleSource
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${slug || "plan"}.md`;
}

function DownloadIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="icon-2xs"
      aria-hidden="true"
    >
      <path
        d="M2.66831 12.6664V12.5004C2.66831 12.1331 2.96607 11.8353 3.33334 11.8353C3.70061 11.8353 3.99838 12.1331 3.99838 12.5004V12.6664C3.99838 13.3773 3.99929 13.8708 4.03061 14.2543C4.0613 14.6299 4.11812 14.8414 4.19858 14.9994L4.26889 15.1263C4.4452 15.4138 4.69823 15.6482 5.00034 15.8021L5.13022 15.8578C5.27399 15.9092 5.4635 15.9471 5.74545 15.9701C6.12897 16.0014 6.62231 16.0013 7.33334 16.0013H12.6664C13.3772 16.0013 13.8708 16.0014 14.2542 15.9701C14.6296 15.9394 14.8414 15.8825 14.9994 15.8021L15.1263 15.7308C15.4137 15.5545 15.6482 15.3014 15.8021 14.9994L15.8578 14.8695C15.9092 14.7258 15.947 14.5361 15.9701 14.2543C16.0014 13.8708 16.0013 13.3772 16.0013 12.6664V12.5004C16.0013 12.1332 16.2992 11.8355 16.6664 11.8353C17.0336 11.8353 17.3314 12.1331 17.3314 12.5004V12.6664C17.3314 13.3554 17.332 13.9125 17.2953 14.3627C17.2625 14.7636 17.1975 15.1248 17.0531 15.4613L16.9867 15.6039C16.7212 16.1248 16.3173 16.5606 15.8216 16.8646L15.6039 16.9867C15.2271 17.1787 14.8206 17.2579 14.3626 17.2953C13.9124 17.3321 13.3554 17.3314 12.6664 17.3314H7.33334C6.64425 17.3314 6.0873 17.3321 5.63706 17.2953C5.23651 17.2626 4.87562 17.1982 4.5394 17.0541L4.39682 16.9867C3.8757 16.7212 3.4392 16.3175 3.1351 15.8217L3.01303 15.6039C2.82106 15.2271 2.74186 14.8207 2.70444 14.3627C2.66767 13.9125 2.66831 13.3554 2.66831 12.6664ZM9.3353 3.33337C9.3353 2.9661 9.63307 2.66833 10.0003 2.66833C10.3675 2.66851 10.6654 2.96621 10.6654 3.33337V10.8939L12.8626 8.69666L12.9671 8.61169C13.2253 8.44097 13.5767 8.4693 13.804 8.69666C14.0634 8.95633 14.0635 9.37748 13.804 9.63708L10.4701 12.9701C10.3454 13.0947 10.1766 13.1653 10.0003 13.1654C9.82397 13.1654 9.65434 13.0948 9.52963 12.9701L6.19663 9.63708L6.11166 9.53259C5.9411 9.27445 5.96934 8.92394 6.19663 8.69666C6.42392 8.46937 6.77442 8.44113 7.03256 8.61169L7.13705 8.69666L9.3353 10.8949V3.33337Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="20"
      height="21"
      viewBox="0 0 20 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("icon-2xs transition-transform duration-200", expanded ? "rotate-0" : "rotate-180")}
      aria-hidden="true"
    >
      <path
        d="M15.2793 7.71101C15.539 7.45131 15.961 7.45131 16.2207 7.71101C16.4804 7.97071 16.4804 8.39272 16.2207 8.65242L10.4707 14.4024C10.211 14.6621 9.78902 14.6621 9.52932 14.4024L3.77932 8.65242L3.69436 8.54792C3.52385 8.28979 3.55205 7.93828 3.77932 7.71101C4.00659 7.48374 4.3581 7.45554 4.61623 7.62605L4.72073 7.71101L10 12.9903L15.2793 7.71101Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.6"
      />
    </svg>
  );
}

interface PlanMessageProps {
  content: string;
  parseIncompleteMarkdown?: boolean;
  defaultExpanded?: boolean;
}

export function PlanMessage({
  content,
  parseIncompleteMarkdown = false,
  defaultExpanded = false,
}: PlanMessageProps) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const downloadFilename = useMemo(() => resolvePlanDownloadFilename(content), [content]);

  const handleDownload = () => {
    if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") {
      return;
    }

    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadFilename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  };

  return (
    <div className="px-2.5">
      <div className="relative overflow-clip rounded-lg bg-token-foreground/5">
        <div className="relative flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span className="text-base/tight font-semibold text-token-foreground">Plan</span>
          <div className="flex items-center gap-1">
            <ThreadActionIconButton label="Download plan" onClick={handleDownload}>
              <DownloadIcon />
            </ThreadActionIconButton>
            <CopyMessageActionButton text={content} label="Copy" copiedLabel="Copied" />
            <ThreadActionIconButton
              label={expanded ? "Collapse plan summary" : "Expand plan summary"}
              aria-controls={contentId}
              aria-expanded={expanded}
              state={expanded ? "open" : "closed"}
              onClick={() => {
                setExpanded((current) => !current);
              }}
            >
              <ChevronIcon expanded={expanded} />
            </ThreadActionIconButton>
          </div>
        </div>

        <div
          id={contentId}
          className="relative overflow-hidden"
          style={{ maxHeight: expanded ? "none" : `${COLLAPSED_PLAN_MAX_HEIGHT_PX}px` }}
        >
          <div className="px-4 py-3">
            <MarkdownRenderer
              content={content}
              parseIncompleteMarkdown={parseIncompleteMarkdown}
              className="codex-markdown-plan"
            />
          </div>

          {!expanded && (
            <>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-linear-to-t from-token-input-background to-transparent" />
              <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                <button
                  type="button"
                  className="pointer-events-auto flex cursor-interaction items-center gap-1 rounded-full border border-token-border bg-token-foreground px-2 py-0.5 text-sm leading-[18px] text-token-dropdown-background transition-colors select-none no-drag hover:bg-token-foreground/80"
                  onClick={() => {
                    setExpanded(true);
                  }}
                >
                  Expand plan
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
