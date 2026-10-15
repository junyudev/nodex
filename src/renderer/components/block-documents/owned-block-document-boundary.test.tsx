import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import {
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
} from "../../../shared/block-documents/page-document";
import {
  SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY,
  SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION,
  SYNCED_BLOCK_SOURCE_TYPE,
} from "../../../shared/block-documents/synced-block-document";
import type { OwnedDocumentDescriptor } from "../../../shared/block-documents/contracts";
import { render } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import {
  OwnedBlockDocumentBoundary,
  RegisteredOwnedBlockDocumentBoundary,
} from "./owned-block-document-boundary";
import { OwnedBlockDocumentBoundaryError } from "@/lib/owned-block-document";

const descriptor = (): OwnedDocumentDescriptor => ({
  libraryId: "library-1",
  routingContext: { kind: "project", projectId: "project-1" },
  ownerBlockId: "card-1",
  ownerType: "page",
  ownerLifecycle: "active",
  documentId: "document:card-1",
  storeEpoch: "store-1",
  generation: 1,
  headSeq: 0,
  schemaKey: PAGE_DOCUMENT_SCHEMA_KEY,
  schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
  readiness: "ready",
  sync: { kind: "yjs", stateVector: new Uint8Array([0]) },
});

describe("OwnedBlockDocumentBoundary", () => {
  test("renders the explicit authority model and can prepare it again after reload", async () => {
    let fetches = 0;
    const fetchDescriptor = async () => {
      fetches += 1;
      return descriptor();
    };
    const view = render(
      <TestQueryProvider>
        <OwnedBlockDocumentBoundary
          routingContext={{ kind: "project", projectId: "project-1" }}
          ownerBlockId="card-1"
          dependencies={{ fetchDescriptor }}
        >
          {(model, controls) => (
            <div>
              <span data-testid="authority">{model.status}</span>
              <button type="button" onClick={() => void controls.reload()}>
                Reload descriptor
              </button>
            </div>
          )}
        </OwnedBlockDocumentBoundary>
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("authority").textContent).toBe("ready");
    });
    expect(fetches).toBe(1);

    fireEvent.click(view.getByRole("button", { name: "Reload descriptor" }));
    await waitFor(() => expect(fetches).toBe(2));
    expect(view.getByTestId("authority").textContent).toBe("ready");
  });

  test("opens a registered non-Page document-bearing Block descriptor", async () => {
    const view = render(
      <TestQueryProvider>
        <RegisteredOwnedBlockDocumentBoundary
          routingContext={{ kind: "project", projectId: "project-1" }}
          ownerBlockId="synced-source-1"
          dependencies={{
            fetchDescriptor: async () => ({
              ...descriptor(),
              ownerBlockId: "synced-source-1",
              ownerType: SYNCED_BLOCK_SOURCE_TYPE,
              documentId: "document:synced-source-1",
              schemaKey: SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY,
              schemaVersion: SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION,
            }),
          }}
        >
          {(model) => <span data-testid="authority">{model.status}</span>}
        </RegisteredOwnedBlockDocumentBoundary>
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("authority").textContent).toBe("ready");
    });
  });

  test("shows a productized busy state and retries a retryable descriptor read", async () => {
    let fetches = 0;
    const view = render(
      <TestQueryProvider>
        <OwnedBlockDocumentBoundary
          routingContext={{ kind: "project", projectId: "project-1" }}
          ownerBlockId="card-1"
          dependencies={{
            fetchDescriptor: async () => {
              fetches += 1;
              if (fetches < 3) {
                throw new OwnedBlockDocumentBoundaryError(
                  "fetch_failed",
                  "Core request deadline was exceeded",
                  { retryable: true },
                );
              }
              return descriptor();
            },
          }}
        >
          {(model) => (
            <span data-testid="authority">
              {model.status === "error" ? model.error.message : model.status}
            </span>
          )}
        </OwnedBlockDocumentBoundary>
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("authority").textContent).toContain("Core is busy");
    });
    expect(view.getByTestId("authority").textContent).not.toContain("deadline exceeded");
    await waitFor(
      () => {
        expect(view.getByTestId("authority").textContent).toBe("ready");
      },
      { timeout: 2_000 },
    );
    expect(fetches).toBe(3);
  });

  test("does not retry a non-retryable descriptor failure", async () => {
    let fetches = 0;
    const view = render(
      <TestQueryProvider>
        <OwnedBlockDocumentBoundary
          routingContext={{ kind: "project", projectId: "project-1" }}
          ownerBlockId="card-1"
          dependencies={{
            fetchDescriptor: async () => {
              fetches += 1;
              throw new OwnedBlockDocumentBoundaryError(
                "document_state_corrupt",
                "Document state is corrupt",
              );
            },
          }}
        >
          {(model) => (
            <span data-testid="authority">
              {model.status === "error" ? model.error.message : model.status}
            </span>
          )}
        </OwnedBlockDocumentBoundary>
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("authority").textContent).toBe("Document state is corrupt");
    });
    expect(fetches).toBe(1);
  });

  test("cancels the retry chain when the document surface unmounts", async () => {
    let fetches = 0;
    const view = render(
      <TestQueryProvider>
        <OwnedBlockDocumentBoundary
          routingContext={{ kind: "project", projectId: "project-1" }}
          ownerBlockId="card-1"
          dependencies={{
            fetchDescriptor: async () => {
              fetches += 1;
              throw new OwnedBlockDocumentBoundaryError(
                "fetch_failed",
                "Core request deadline was exceeded",
                { retryable: true },
              );
            },
          }}
        >
          {(model) => <span>{model.status}</span>}
        </OwnedBlockDocumentBoundary>
      </TestQueryProvider>,
    );

    await waitFor(() => expect(fetches).toBe(1));
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(fetches).toBe(1);
  });
});
