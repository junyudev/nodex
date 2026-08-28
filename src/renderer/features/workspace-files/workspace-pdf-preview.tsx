import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from "pdfjs-dist";
import type { IPDFLinkService } from "pdfjs-dist/types/web/interfaces";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { ChevronLeft, Minus } from "@/components/shared/icons/generic-icons";
import {
  CheckmarkIcon,
  ChevronRightIcon,
  CompactChevronDownIcon,
  PlusIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";
import {
  clampWorkspacePdfPage,
  decodeWorkspacePdfDataUrl,
  resolveWorkspacePdfPageSize,
  resolveWorkspacePdfZoomPercent,
  selectWorkspacePdfCurrentPage,
  stepWorkspacePdfZoom,
  WORKSPACE_PDF_ZOOM_STEPS,
  type WorkspacePdfPageSize,
} from "./workspace-pdf-preview-model";
import { loadWorkspacePdfRuntime, type WorkspacePdfRuntime } from "./workspace-pdf-runtime";
import "./workspace-pdf-preview.css";

const PAGE_SELECTOR = "[data-workspace-pdf-page]";
const PAGE_VISIBILITY_THRESHOLDS = [0, 0.25, 0.5, 0.75, 1];
const PAGE_RENDER_ROOT_MARGIN = "200px 0px";
const ZOOM_GESTURE_END_MS = 120;
const WHEEL_DELTA_THRESHOLD = 5;
const WHEEL_DELTA_RESET_MS = 200;

type PdfLoadState =
  | { status: "loading"; dataUrl: string }
  | { status: "error"; dataUrl: string }
  | {
      status: "ready";
      dataUrl: string;
      document: PDFDocumentProxy;
      firstPageSize: WorkspacePdfPageSize;
    };

interface WorkspacePdfPreviewProps {
  fileDataUrl: string;
  title: string;
  onOpenExternalLink: (url: string) => void;
}

interface ZoomAnchor {
  containerOffsetX: number;
  containerOffsetY: number;
  pageNumber: number;
  ratioX: number;
  ratioY: number;
}

function useWorkspacePdfDocument(fileDataUrl: string): PdfLoadState {
  const [state, setState] = useState<PdfLoadState>({ status: "loading", dataUrl: fileDataUrl });

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setState({ status: "loading", dataUrl: fileDataUrl });

    const load = async () => {
      try {
        const runtime = await loadWorkspacePdfRuntime();
        if (cancelled) return;
        const bytes = decodeWorkspacePdfDataUrl(fileDataUrl);
        if (bytes === null) {
          setState({ status: "error", dataUrl: fileDataUrl });
          return;
        }

        loadingTask = runtime.getDocument({ data: bytes });
        const document = await loadingTask.promise;
        if (cancelled) {
          await document.destroy();
          return;
        }
        if (!Number.isSafeInteger(document.numPages) || document.numPages <= 0) {
          await document.destroy();
          setState({ status: "error", dataUrl: fileDataUrl });
          return;
        }

        const firstPage = await document.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });
        if (cancelled) {
          await document.destroy();
          return;
        }
        setState({
          status: "ready",
          dataUrl: fileDataUrl,
          document,
          firstPageSize: { width: viewport.width, height: viewport.height },
        });
      } catch {
        if (!cancelled) setState({ status: "error", dataUrl: fileDataUrl });
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (loadingTask !== null && !loadingTask.destroyed) {
        void loadingTask.destroy().catch(() => undefined);
      }
    };
  }, [fileDataUrl]);

  return state;
}

function getPdfPageElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(PAGE_SELECTOR));
}

function useWorkspacePdfPageNavigation(input: {
  containerRef: RefObject<HTMLDivElement | null>;
  navigationKey: string;
  totalPages: number;
}) {
  const { containerRef, navigationKey, totalPages } = input;
  const [currentPage, setCurrentPage] = useState(1);
  const programmaticPageRef = useRef<number | null>(null);
  const scrollCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    programmaticPageRef.current = null;
    scrollCleanupRef.current?.();
    scrollCleanupRef.current = null;
    setCurrentPage(1);
  }, [navigationKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || totalPages < 1 || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const pages = getPdfPageElements(container);
    if (pages.length === 0) return undefined;

    const visibility = new Map<Element, number>(pages.map((page) => [page, 0]));
    const selectCurrentPage = () => {
      const nextPage = selectWorkspacePdfCurrentPage({
        containerTop: container.getBoundingClientRect().top,
        pageTops: pages.map((page) => page.getBoundingClientRect().top),
        visibilityRatios: pages.map((page) => visibility.get(page) ?? 0),
      });
      if (
        nextPage !== null &&
        (programmaticPageRef.current === null || nextPage === programmaticPageRef.current)
      ) {
        if (nextPage === programmaticPageRef.current) {
          programmaticPageRef.current = null;
          scrollCleanupRef.current?.();
          scrollCleanupRef.current = null;
        }
        setCurrentPage(nextPage);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visibility.set(entry.target, entry.intersectionRatio);
        selectCurrentPage();
      },
      { root: container, threshold: PAGE_VISIBILITY_THRESHOLDS },
    );
    for (const page of pages) observer.observe(page);
    selectCurrentPage();
    return () => {
      observer.disconnect();
      programmaticPageRef.current = null;
      scrollCleanupRef.current?.();
      scrollCleanupRef.current = null;
    };
  }, [containerRef, navigationKey, totalPages]);

  const goToPage = useCallback(
    (requestedPage: number, behavior: ScrollBehavior = "smooth") => {
      const container = containerRef.current;
      if (container === null) return;
      const page = clampWorkspacePdfPage(requestedPage, totalPages);
      const pageElement = getPdfPageElements(container).at(page - 1);
      if (pageElement === undefined) return;

      scrollCleanupRef.current?.();
      programmaticPageRef.current = page;
      let timeout: number | null = null;
      const finish = () => {
        if (programmaticPageRef.current !== page) return;
        programmaticPageRef.current = null;
        cleanup();
        setCurrentPage(page);
      };
      const handleScroll = () => {
        if (timeout !== null) window.clearTimeout(timeout);
        timeout = window.setTimeout(finish, 100);
      };
      const cleanup = () => {
        if (timeout !== null) window.clearTimeout(timeout);
        container.removeEventListener("scroll", handleScroll);
      };
      scrollCleanupRef.current = cleanup;
      pageElement.scrollIntoView({ behavior, block: "start" });
      setCurrentPage(page);
      handleScroll();
      container.addEventListener("scroll", handleScroll);
    },
    [containerRef, totalPages],
  );

  return { currentPage: clampWorkspacePdfPage(currentPage, totalPages), goToPage };
}

function isPdfReference(value: unknown): value is { num: number; gen: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "num" in value &&
    typeof value.num === "number" &&
    "gen" in value &&
    typeof value.gen === "number"
  );
}

class WorkspacePdfLinkService implements IPDFLinkService {
  readonly isInPresentationMode = false;
  externalLinksEnabled = true;

  constructor(
    private readonly document: PDFDocumentProxy,
    private readonly scrollRootRef: RefObject<HTMLDivElement | null>,
    private readonly goToPageCallback: (page: number) => void,
    private readonly openExternalLink: (url: string) => void,
  ) {}

  get pagesCount() {
    return this.document.numPages;
  }

  set page(value: number) {
    this.goToPageCallback(value);
  }

  get page() {
    return 1;
  }

  set rotation(_value: number) {}

  get rotation() {
    return 0;
  }

  set externalLinkEnabled(value: boolean) {
    this.externalLinksEnabled = value;
  }

  get externalLinkEnabled() {
    return this.externalLinksEnabled;
  }

  async goToDestination(destination: string | unknown[]): Promise<void> {
    const resolved =
      typeof destination === "string"
        ? await this.document.getDestination(destination)
        : destination;
    if (resolved === null) return;
    const page = await this.getDestinationPageNumber(resolved);
    if (page !== null) this.goToPageCallback(page);
  }

  goToPage(value: string | number) {
    const page = Number(value);
    if (Number.isInteger(page)) this.goToPageCallback(page);
  }

  goToXY(pageNumber: number) {
    this.goToPageCallback(pageNumber);
  }

  addLinkAttributes(link: HTMLAnchorElement, url: string) {
    if (!url || !this.externalLinksEnabled) {
      link.href = "";
      return;
    }
    link.href = url;
    link.title = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer nofollow";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openExternalLink(url);
    });
  }

  getDestinationHash(destination: unknown) {
    return typeof destination === "string" && destination.length > 0
      ? this.getAnchorUrl(`#${window.encodeURIComponent(destination)}`)
      : this.getAnchorUrl("");
  }

  getAnchorUrl(hash: unknown) {
    return typeof hash === "string" ? hash : "";
  }

  setHash(_hash: string) {}

  executeNamedAction(action: string) {
    const container = this.scrollRootRef.current;
    if (container === null) return;
    const current = Number(
      container.querySelector<HTMLElement>(`${PAGE_SELECTOR}[data-current-page="true"]`)?.dataset
        .pageNumber ?? 1,
    );
    if (action === "NextPage") this.goToPageCallback(current + 1);
    if (action === "PrevPage") this.goToPageCallback(current - 1);
    if (action === "FirstPage") this.goToPageCallback(1);
    if (action === "LastPage") this.goToPageCallback(this.document.numPages);
  }

  executeSetOCGState(_action: object) {}

  private async getDestinationPageNumber(destination: unknown[]): Promise<number | null> {
    const reference = destination[0];
    if (typeof reference === "number" && Number.isInteger(reference)) return reference + 1;
    if (!isPdfReference(reference)) return null;
    const cached = this.document.cachedPageNumber(reference);
    if (cached !== null) return cached;
    try {
      return (await this.document.getPageIndex(reference)) + 1;
    } catch {
      return null;
    }
  }
}

function WorkspacePdfTextLayer(input: {
  page: PDFPageProxy;
  runtime: WorkspacePdfRuntime;
  deferMs: number;
}) {
  const { page, runtime, deferMs } = input;
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = layerRef.current;
    if (container === null) return undefined;
    container.innerHTML = "";
    let cancelled = false;
    let textLayer: InstanceType<WorkspacePdfRuntime["TextLayer"]> | null = null;
    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      textLayer = new runtime.TextLayer({
        container,
        textContentSource: page.streamTextContent({ includeMarkedContent: true }),
        viewport: page.getViewport({ scale: 1 }),
      });
      void textLayer
        .render()
        .then(() => {
          if (cancelled) return;
          const end = document.createElement("div");
          end.className = "endOfContent";
          container.append(end);
        })
        .catch(() => undefined);
    }, deferMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      textLayer?.cancel();
      container.innerHTML = "";
    };
  }, [deferMs, page, runtime]);

  return <div ref={layerRef} className="textLayer" />;
}

function WorkspacePdfAnnotationLayer(input: {
  deferMs: number;
  linkService: IPDFLinkService;
  page: PDFPageProxy;
  runtime: WorkspacePdfRuntime;
}) {
  const { deferMs, linkService, page, runtime } = input;
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = layerRef.current;
    if (container === null) return undefined;
    container.innerHTML = "";
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void (async () => {
        const annotations = await page.getAnnotations();
        if (cancelled || annotations.length === 0) return;
        const viewport = page.getViewport({ scale: 1 });
        const layer = new runtime.AnnotationLayer({
          accessibilityManager: undefined,
          annotationCanvasMap: undefined,
          annotationEditorUIManager: undefined,
          annotationStorage: undefined,
          commentManager: undefined,
          div: container,
          linkService,
          page,
          structTreeLayer: undefined,
          viewport,
        });
        await layer.render({
          annotations,
          div: container,
          linkService,
          page,
          renderForms: false,
          viewport,
        });
      })().catch(() => undefined);
    }, deferMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      container.innerHTML = "";
    };
  }, [deferMs, linkService, page, runtime]);

  return <div ref={layerRef} className="annotationLayer" />;
}

function isRenderingCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "RenderingCancelledException"
  );
}

function WorkspacePdfPage(input: {
  currentPage: number;
  document: PDFDocumentProxy;
  fallbackSize: WorkspacePdfPageSize;
  fitToWidth: boolean;
  isZooming: boolean;
  linkService: IPDFLinkService;
  onError: () => void;
  pageNumber: number;
  pageWidth: number | null;
  runtime: WorkspacePdfRuntime;
  scrollRootRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  zoomEndTick: number;
}) {
  const {
    currentPage,
    document,
    fallbackSize,
    fitToWidth,
    isZooming,
    linkService,
    onError,
    pageNumber,
    pageWidth,
    runtime,
    scrollRootRef,
    zoom,
    zoomEndTick,
  } = input;
  const pageElementRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pageState, setPageState] = useState<{
    document: PDFDocumentProxy;
    page: PDFPageProxy;
    viewport: PageViewport;
  } | null>(null);
  const [intersectsRenderWindow, setIntersectsRenderWindow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPageState(null);
    void document
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return;
        setPageState({ document, page, viewport: page.getViewport({ scale: 1 }) });
      })
      .catch(() => {
        if (!cancelled) onError();
      });
    return () => {
      cancelled = true;
    };
  }, [document, onError, pageNumber]);

  useEffect(() => {
    const element = pageElementRef.current;
    if (element === null) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setIntersectsRenderWindow(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setIntersectsRenderWindow(Boolean(entry?.isIntersecting)),
      { root: scrollRootRef.current, rootMargin: PAGE_RENDER_ROOT_MARGIN, threshold: 0.01 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRootRef]);

  const loadedPage = pageState?.document === document ? pageState.page : null;
  const baseSize = pageState
    ? { width: pageState.viewport.width, height: pageState.viewport.height }
    : fallbackSize;
  const pageSize = resolveWorkspacePdfPageSize({
    baseSize,
    availableWidth: pageWidth,
    fitToWidth,
    zoom,
  });
  const distanceFromCurrent = Math.abs(currentPage - pageNumber);
  const shouldRender = intersectsRenderWindow || distanceFromCurrent <= 2;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    if (loadedPage === null || !shouldRender) {
      canvas.width = 0;
      canvas.height = 0;
      return undefined;
    }
    if (isZooming) return undefined;

    const baseViewport = loadedPage.getViewport({ scale: 1 });
    if (baseViewport.width <= 0 || pageSize.width <= 0 || pageSize.height <= 0) return undefined;
    const deviceScale = window.devicePixelRatio || 1;
    const pixelWidth = Math.ceil(pageSize.width * deviceScale);
    const pixelHeight = Math.ceil(pageSize.height * deviceScale);
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.getContext("2d")?.clearRect(0, 0, pixelWidth, pixelHeight);
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    try {
      renderTask = loadedPage.render({
        canvas,
        viewport: loadedPage.getViewport({ scale: pixelWidth / baseViewport.width }),
      });
      void renderTask.promise.catch((error: unknown) => {
        if (!cancelled && !isRenderingCancelled(error)) onError();
      });
    } catch (error) {
      if (!isRenderingCancelled(error)) onError();
    }
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [isZooming, loadedPage, onError, pageSize.height, pageSize.width, shouldRender, zoomEndTick]);

  const scaleFactor = pageState?.viewport.width ? pageSize.width / pageState.viewport.width : 1;
  const style = {
    "--scale-factor": scaleFactor,
    "--user-unit": loadedPage?.userUnit ?? 1,
    width: pageSize.width,
    height: pageSize.height,
  } as CSSProperties;
  const layerDelay = 50 + distanceFromCurrent * 40;

  return (
    <div
      ref={pageElementRef}
      className="workspacePdfPreviewPage relative shrink-0 overflow-hidden border border-token-border bg-white shadow-sm"
      data-workspace-pdf-page
      data-page-number={pageNumber}
      data-current-page={currentPage === pageNumber}
      data-page-viewport-ready={pageState === null ? undefined : ""}
      style={style}
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      {loadedPage !== null && !isZooming && shouldRender ? (
        <>
          <WorkspacePdfTextLayer page={loadedPage} runtime={runtime} deferMs={layerDelay} />
          <WorkspacePdfAnnotationLayer
            deferMs={layerDelay + distanceFromCurrent * 60}
            linkService={linkService}
            page={loadedPage}
            runtime={runtime}
          />
        </>
      ) : null}
    </div>
  );
}

function PdfPageNavigation(input: {
  currentPage: number;
  totalPages: number;
  onNextPage: () => void;
  onPreviousPage: () => void;
}) {
  const { currentPage, totalPages, onNextPage, onPreviousPage } = input;
  return (
    <div className="flex items-center gap-0.5 text-xs tabular-nums text-token-text-secondary">
      <button
        type="button"
        aria-label="Previous page"
        className="flex size-7 items-center justify-center rounded-md hover:bg-token-list-hover-background disabled:opacity-35"
        disabled={currentPage <= 1}
        onClick={onPreviousPage}
      >
        <ChevronLeft className="icon-2xs" />
      </button>
      <span className="min-w-12 text-center">
        {currentPage}/{totalPages}
      </span>
      <button
        type="button"
        aria-label="Next page"
        className="flex size-7 items-center justify-center rounded-md hover:bg-token-list-hover-background disabled:opacity-35"
        disabled={currentPage >= totalPages}
        onClick={onNextPage}
      >
        <ChevronRightIcon className="icon-2xs" />
      </button>
    </div>
  );
}

function PdfZoomControl(input: {
  fitToWidth: boolean;
  zoomPercent: number;
  onFitToWidth: () => void;
  onZoomPercentChange: (zoom: number) => void;
}) {
  const { fitToWidth, zoomPercent, onFitToWidth, onZoomPercentChange } = input;
  const commonOptions = [0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4] as const;
  return (
    <NodexDropdownMenu
      align="end"
      sideOffset={4}
      contentClassName="!w-[136px] !min-w-[136px] !rounded-[10px] !p-[6px]"
      triggerButton={
        <button
          type="button"
          aria-label={`Zoom, ${zoomPercent}%`}
          className="flex h-7 items-center gap-0.5 rounded-md px-2 text-xs tabular-nums text-token-text-secondary hover:bg-token-list-hover-background"
        >
          {zoomPercent}%
          <CompactChevronDownIcon className="icon-2xs opacity-50" />
        </button>
      }
    >
      {commonOptions.map((option) => (
        <NodexDropdownItem
          key={option}
          className="!rounded-[6px] !py-[5px] !ps-2 !pe-[5px] text-token-text-primary"
          rightSlot={
            <CheckmarkIcon
              className={cn(
                "icon-sm",
                !fitToWidth && Math.round(option * 100) === zoomPercent ? undefined : "invisible",
              )}
            />
          }
          onSelect={() => onZoomPercentChange(option)}
        >
          {Math.round(option * 100)}%
        </NodexDropdownItem>
      ))}
      <NodexDropdownSeparator className="py-0" />
      <NodexDropdownItem
        className="!rounded-[6px] !py-[5px] !ps-2 !pe-[5px] text-token-text-primary"
        rightSlot={
          <CheckmarkIcon className={cn("icon-sm", fitToWidth ? undefined : "invisible")} />
        }
        onSelect={onFitToWidth}
      >
        Fit width
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

export function WorkspacePdfPreview({
  fileDataUrl,
  title,
  onOpenExternalLink,
}: WorkspacePdfPreviewProps) {
  const loadState = useWorkspacePdfDocument(fileDataUrl);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const zoomTimeoutRef = useRef<number | null>(null);
  const wheelResetTimeoutRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const [resizeTarget, setResizeTarget] = useState<HTMLDivElement | null>(null);
  const [fitToWidth, setFitToWidth] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [isZooming, setIsZooming] = useState(false);
  const [zoomEndTick, setZoomEndTick] = useState(0);
  const [runtime, setRuntime] = useState<WorkspacePdfRuntime | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);

  const currentLoadState = loadState.dataUrl === fileDataUrl ? loadState : null;
  const pdfDocument = currentLoadState?.status === "ready" ? currentLoadState.document : null;
  const totalPages = pdfDocument?.numPages ?? 0;
  const { currentPage, goToPage } = useWorkspacePdfPageNavigation({
    containerRef: scrollRootRef,
    navigationKey: fileDataUrl,
    totalPages,
  });

  useEffect(() => {
    let cancelled = false;
    void loadWorkspacePdfRuntime().then((loadedRuntime) => {
      if (!cancelled) setRuntime(loadedRuntime);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setRenderFailed(false);
    setFitToWidth(true);
    setZoom(1);
  }, [fileDataUrl]);

  useEffect(() => {
    if (resizeTarget === null || typeof ResizeObserver === "undefined") return undefined;
    const update = (width: number) => setAvailableWidth(Math.max(0, Math.floor(width) - 48));
    update(resizeTarget.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined && entry.contentRect.width > 0) update(entry.contentRect.width);
    });
    observer.observe(resizeTarget);
    return () => observer.disconnect();
  }, [resizeTarget]);

  useEffect(
    () => () => {
      if (zoomTimeoutRef.current !== null) window.clearTimeout(zoomTimeoutRef.current);
      if (wheelResetTimeoutRef.current !== null) {
        window.clearTimeout(wheelResetTimeoutRef.current);
      }
    },
    [],
  );

  const captureZoomAnchor = useCallback(
    (clientX?: number, clientY?: number) => {
      const container = scrollRootRef.current;
      if (container === null) return;
      const containerRect = container.getBoundingClientRect();
      const x = clientX ?? containerRect.left + containerRect.width / 2;
      const y = clientY ?? containerRect.top + containerRect.height / 2;
      let page =
        window.document.elementFromPoint(x, y)?.closest<HTMLElement>(PAGE_SELECTOR) ?? null;
      if (page === null || !container.contains(page)) {
        page =
          getPdfPageElements(container).find(
            (candidate) => Number(candidate.dataset.pageNumber) === currentPage,
          ) ?? null;
      }
      if (page === null) return;
      const pageRect = page.getBoundingClientRect();
      if (pageRect.width <= 0 || pageRect.height <= 0) return;
      zoomAnchorRef.current = {
        containerOffsetX: x - containerRect.left,
        containerOffsetY: y - containerRect.top,
        pageNumber: Number(page.dataset.pageNumber),
        ratioX: Math.min(1, Math.max(0, (x - pageRect.left) / pageRect.width)),
        ratioY: Math.min(1, Math.max(0, (y - pageRect.top) / pageRect.height)),
      };
    },
    [currentPage],
  );

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const container = scrollRootRef.current;
    if (anchor === null || container === null) return;
    const page = getPdfPageElements(container).find(
      (candidate) => Number(candidate.dataset.pageNumber) === anchor.pageNumber,
    );
    if (page === undefined) return;
    const containerRect = container.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    container.scrollLeft +=
      pageRect.left +
      pageRect.width * anchor.ratioX -
      (containerRect.left + anchor.containerOffsetX);
    container.scrollTop +=
      pageRect.top +
      pageRect.height * anchor.ratioY -
      (containerRect.top + anchor.containerOffsetY);
    zoomAnchorRef.current = null;
  }, [availableWidth, fitToWidth, zoom]);

  const beginZoom = useCallback(() => {
    setIsZooming(true);
    if (zoomTimeoutRef.current !== null) window.clearTimeout(zoomTimeoutRef.current);
    zoomTimeoutRef.current = window.setTimeout(() => {
      zoomTimeoutRef.current = null;
      setIsZooming(false);
      setZoomEndTick((tick) => tick + 1);
    }, ZOOM_GESTURE_END_MS);
  }, []);

  const applyZoom = useCallback(
    (nextZoom: number, anchor?: { clientX: number; clientY: number }) => {
      captureZoomAnchor(anchor?.clientX, anchor?.clientY);
      beginZoom();
      flushSync(() => {
        setFitToWidth(false);
        setZoom(nextZoom);
      });
    },
    [beginZoom, captureZoomAnchor],
  );

  useEffect(() => {
    const container = scrollRootRef.current;
    if (container === null) return undefined;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      wheelDeltaRef.current += event.deltaY;
      if (wheelResetTimeoutRef.current !== null) {
        window.clearTimeout(wheelResetTimeoutRef.current);
      }
      wheelResetTimeoutRef.current = window.setTimeout(() => {
        wheelDeltaRef.current = 0;
        wheelResetTimeoutRef.current = null;
      }, WHEEL_DELTA_RESET_MS);
      if (Math.abs(wheelDeltaRef.current) < WHEEL_DELTA_THRESHOLD) return;
      const direction = wheelDeltaRef.current > 0 ? "out" : "in";
      wheelDeltaRef.current = 0;
      const currentZoom =
        fitToWidth && currentLoadState?.status === "ready"
          ? (availableWidth ?? currentLoadState.firstPageSize.width) /
            currentLoadState.firstPageSize.width
          : zoom;
      applyZoom(stepWorkspacePdfZoom(currentZoom, direction), event);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [applyZoom, availableWidth, currentLoadState, fitToWidth, zoom]);

  const fitWidth = useCallback(() => {
    if (fitToWidth) return;
    captureZoomAnchor();
    beginZoom();
    flushSync(() => setFitToWidth(true));
  }, [beginZoom, captureZoomAnchor, fitToWidth]);

  const linkService = useMemo(
    () =>
      pdfDocument === null
        ? null
        : new WorkspacePdfLinkService(pdfDocument, scrollRootRef, goToPage, onOpenExternalLink),
    [goToPage, onOpenExternalLink, pdfDocument],
  );
  const handleRenderError = useCallback(() => setRenderFailed(true), []);
  const setScrollRoot = useCallback((element: HTMLDivElement | null) => {
    scrollRootRef.current = element;
    setResizeTarget((current) => (current === element ? current : element));
  }, []);
  const zoomPercent =
    currentLoadState?.status === "ready"
      ? resolveWorkspacePdfZoomPercent({
          baseWidth: currentLoadState.firstPageSize.width,
          pageWidth: availableWidth,
          fitToWidth,
          zoom,
        })
      : 100;
  const currentZoom = zoomPercent / 100;

  if (currentLoadState === null || currentLoadState.status === "loading" || runtime === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-token-text-secondary">
        Loading PDF…
      </div>
    );
  }
  if (currentLoadState.status === "error" || renderFailed || linkService === null) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-token-text-secondary">
        Unable to preview this PDF.
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-token-main-surface-primary">
      <div className="flex h-10 shrink-0 items-center justify-between border-b-[0.5px] border-token-border px-2">
        <PdfPageNavigation
          currentPage={currentPage}
          totalPages={totalPages}
          onPreviousPage={() => goToPage(currentPage - 1)}
          onNextPage={() => goToPage(currentPage + 1)}
        />
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Zoom out"
            className="flex size-7 items-center justify-center rounded-md text-token-text-secondary hover:bg-token-list-hover-background disabled:opacity-35"
            disabled={currentZoom <= WORKSPACE_PDF_ZOOM_STEPS[0]}
            onClick={() => applyZoom(stepWorkspacePdfZoom(currentZoom, "out"))}
          >
            <Minus className="icon-2xs" />
          </button>
          <PdfZoomControl
            fitToWidth={fitToWidth}
            zoomPercent={zoomPercent}
            onFitToWidth={fitWidth}
            onZoomPercentChange={(nextZoom) => applyZoom(nextZoom)}
          />
          <button
            type="button"
            aria-label="Zoom in"
            className="flex size-7 items-center justify-center rounded-md text-token-text-secondary hover:bg-token-list-hover-background disabled:opacity-35"
            disabled={currentZoom >= (WORKSPACE_PDF_ZOOM_STEPS.at(-1) ?? 8)}
            onClick={() => applyZoom(stepWorkspacePdfZoom(currentZoom, "in"))}
          >
            <PlusIcon className="icon-2xs" />
          </button>
        </div>
      </div>
      <div
        ref={setScrollRoot}
        aria-label={`PDF preview for ${title}`}
        className="min-h-0 flex-1 overflow-auto bg-token-main-surface-primary"
        data-testid="workspace-pdf-preview"
      >
        <div className="min-h-full py-6">
          <div className="flex min-h-full w-max min-w-full flex-col items-center gap-6 px-6">
            {Array.from({ length: totalPages }, (_, index) => (
              <WorkspacePdfPage
                key={index + 1}
                currentPage={currentPage}
                document={currentLoadState.document}
                fallbackSize={currentLoadState.firstPageSize}
                fitToWidth={fitToWidth}
                isZooming={isZooming}
                linkService={linkService}
                onError={handleRenderError}
                pageNumber={index + 1}
                pageWidth={availableWidth}
                runtime={runtime}
                scrollRootRef={scrollRootRef}
                zoom={zoom}
                zoomEndTick={zoomEndTick}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
