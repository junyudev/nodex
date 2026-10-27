import { useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import { cn } from "@/lib/utils";
import styles from "./searchable-page-layout.module.css";

/** The medium page column and its 30px gutter. */
export const SEARCHABLE_PAGE_COLUMN_CLASS = "mx-auto w-full max-w-[960px] px-7.5";

export interface SearchablePageLayoutProps {
  /** The page heading, rendered as the header's h1. */
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  /** The search field, laid out in the header toolbar. */
  readonly search?: ReactNode;
  /** Header actions after the search field. */
  readonly headerAction?: ReactNode;
  /** Controls (such as tabs) in their own row under the subtitle; they scroll with the page. */
  readonly stickyControls?: ReactNode;
  readonly contentClassName?: string;
  readonly children?: ReactNode;
}

/** Keeps the pinned header's opaque fill from painting above the scroll viewport. */
function syncHeaderBackgroundTopInset(scrollContainer: HTMLElement, header: HTMLElement) {
  const inset = Math.max(
    0,
    scrollContainer.getBoundingClientRect().top - header.getBoundingClientRect().top,
  );
  header.style.setProperty("--header-background-top-inset", `${inset}px`);
}

/**
 * A browse page whose title row (title, search, actions) stays pinned while the subtitle,
 * controls, and content scroll beneath it. A hairline appears under the title row once content
 * scrolls under it; below a 48rem header width the toolbar wraps under the title.
 */
export function SearchablePageLayout({
  title,
  subtitle,
  search,
  headerAction,
  stickyControls,
  contentClassName,
  children,
}: SearchablePageLayoutProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const headerContentRef = useRef<HTMLDivElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);

  // Publish the content start and the collapse offset, and mark the header collapsible.
  useLayoutEffect(() => {
    const shell = headerRef.current;
    const content = headerContentRef.current;
    if (!shell || !content) return;
    const resizeObserver = new ResizeObserver(() => {
      const contentStart =
        content.offsetLeft + parseFloat(getComputedStyle(content).paddingInlineStart);
      shell.style.setProperty("--header-content-start", `${contentStart}px`);
      const titleContent = content.querySelector(`.${styles.titleContent}`);
      if (content.querySelector(`.${styles.toolbar}`) == null || titleContent == null) {
        shell.removeAttribute("data-collapsible");
        return;
      }
      shell.style.setProperty(
        "--header-collapse-offset",
        `${(titleContent.parentElement?.offsetHeight ?? 0) + parseFloat(getComputedStyle(shell).paddingTop)}px`,
      );
      shell.toggleAttribute("data-collapsible", true);
    });
    const observeTargets = () => {
      resizeObserver.disconnect();
      for (const element of [content, ...content.querySelectorAll(`.${styles.title}`)]) {
        resizeObserver.observe(element);
      }
    };
    const mutationObserver = new MutationObserver(observeTargets);
    mutationObserver.observe(content, { childList: true, characterData: true, subtree: true });
    observeTargets();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const scrollContainer = scrollRef.current;
    const header = headerRef.current;
    if (!scrollContainer || !header) return;
    const resizeObserver = new ResizeObserver(() =>
      syncHeaderBackgroundTopInset(scrollContainer, header),
    );
    resizeObserver.observe(scrollContainer);
    resizeObserver.observe(header);
    return () => {
      resizeObserver.disconnect();
      header.style.removeProperty("--header-background-top-inset");
    };
  }, []);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const scrollContainer = event.currentTarget;
    const header = headerRef.current;
    if (!header) return;
    // Scrolled once the pinned row actually sticks, not when the top padding first moves.
    setIsScrolled(
      scrollContainer.scrollTop > 0 &&
        header.getBoundingClientRect().top <=
          scrollContainer.getBoundingClientRect().top + parseFloat(getComputedStyle(header).top),
    );
    syncHeaderBackgroundTopInset(scrollContainer, header);
  };

  return (
    <div
      ref={scrollRef}
      data-searchable-page=""
      className="relative h-full min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
      onScroll={onScroll}
    >
      <div className="flex min-h-full w-full flex-col">
        <div
          ref={headerRef}
          data-scroll-collapse=""
          data-expand-search=""
          data-sticky=""
          data-wrap-actions=""
          data-scrolled={isScrolled || undefined}
          className={cn(
            styles.shell,
            isScrolled ? "border-(--color-border-subtle)" : "border-transparent",
          )}
        >
          <div ref={headerContentRef} className={cn(styles.content, SEARCHABLE_PAGE_COLUMN_CLASS)}>
            <div className={styles.headerRow}>
              <div className={styles.title}>
                <div className={styles.titleContent}>
                  <h1 className="flex min-h-9 items-center text-[24px] leading-[1.2] font-medium text-token-foreground">
                    {title}
                  </h1>
                </div>
              </div>
              <div className={styles.actions}>
                <div className={styles.toolbar}>
                  <div className={styles.viewControls} />
                  {search == null ? null : <div className={styles.search}>{search}</div>}
                  <div className={styles.pageActions}>{headerAction}</div>
                </div>
              </div>
            </div>
            <div className={styles.navigation} />
          </div>
        </div>
        {subtitle == null ? null : (
          <div className="@container/searchable-header">
            <div
              data-page-subtitle=""
              className={cn(
                styles.subtitle,
                "text-base leading-6 text-(--color-text-secondary)",
                SEARCHABLE_PAGE_COLUMN_CLASS,
              )}
            >
              <div className="max-w-lg -translate-y-1.5">{subtitle}</div>
            </div>
          </div>
        )}
        {stickyControls == null ? null : (
          <div className={cn("flex min-h-15 min-w-0 items-center", SEARCHABLE_PAGE_COLUMN_CLASS)}>
            {stickyControls}
          </div>
        )}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col pb-4",
            SEARCHABLE_PAGE_COLUMN_CLASS,
            contentClassName,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
