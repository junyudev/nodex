import { EventBus, PDFLinkService } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { RefObject } from "react";

const PAGE_SELECTOR = "[data-workspace-pdf-page]";

/** Keep PDF navigation in the Files viewer and route external links through the host. */
export class WorkspacePdfLinkService extends PDFLinkService {
  override get isInPresentationMode() {
    return false;
  }

  constructor(
    private readonly document: PDFDocumentProxy,
    private readonly scrollRootRef: RefObject<HTMLDivElement | null>,
    private readonly goToPageCallback: (page: number) => void,
    private readonly openExternalLink: (url: string) => void,
  ) {
    super({ eventBus: new EventBus() });
    this.setDocument(document);
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
    if (!url || !this.externalLinkEnabled) {
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

  override async executeSetOCGState(_action: object) {}

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
