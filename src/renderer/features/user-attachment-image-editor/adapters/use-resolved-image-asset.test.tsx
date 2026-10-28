import { act, useState } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "../../../test/browser-globals";
import { render } from "../../../test/dom";
import { createTestQueryClient, TestQueryProvider } from "../../../test/query";
import { useResolvedImageAsset } from "./use-resolved-image-asset";

function AssetProbe({
  allowLocalPath = false,
  source,
}: {
  allowLocalPath?: boolean;
  source: string;
}) {
  const asset = useResolvedImageAsset(source, { allowLocalPath });
  const [materialized, setMaterialized] = useState<string | null>(null);
  return (
    <div>
      <span data-testid="preview">{asset.previewSrc}</span>
      <span data-testid="status">
        {asset.isLoading ? "loading" : asset.isError ? "error" : "ready"}
      </span>
      <span data-testid="materialized">{materialized}</span>
      <button
        type="button"
        onClick={() => {
          void asset.materialize().then(setMaterialized);
        }}
      >
        Materialize
      </button>
      <button type="button" onClick={() => void asset.refetch()}>
        Retry
      </button>
    </div>
  );
}

const invokeCalls: Array<[string, unknown]> = [];

beforeEach(() => {
  invokeCalls.length = 0;
  installWindowApi({
    invoke: async (channel: string, input: unknown) => {
      invokeCalls.push([channel, input]);
      if (channel === "read-file-binary") {
        return { contentsBase64: "AQID", mimeType: "image/png" };
      }
      if (channel === "codex:conversation-image-asset:resolve") {
        return { ok: true, dataBase64: "BAUG", mimeType: "image/webp" };
      }
      throw new Error(`Unexpected channel: ${channel}`);
    },
    on: () => () => undefined,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useResolvedImageAsset", () => {
  test("keeps local-path materialization lazy and behind explicit access", async () => {
    const view = render(
      <TestQueryProvider>
        <AssetProbe source="/tmp/hero.png" allowLocalPath />
      </TestQueryProvider>,
    );

    expect(view.getByTestId("preview").textContent).toBe("app://fs/@fs/tmp/hero.png");
    expect(invokeCalls).toEqual([]);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Materialize" }));
    });
    await waitFor(() => {
      expect(view.getByTestId("materialized").textContent).toBe("data:image/png;base64,AQID");
    });
    expect(invokeCalls.map(([channel]) => channel)).toEqual(["read-file-binary"]);
  });

  test("rejects local paths when the caller lacks local-path access", () => {
    const view = render(
      <TestQueryProvider>
        <AssetProbe source="/tmp/hero.png" />
      </TestQueryProvider>,
    );

    expect(view.getByTestId("preview").textContent).toBe("");
    expect(view.getByTestId("status").textContent).toBe("error");
    expect(invokeCalls).toEqual([]);
  });

  test("resolves pointer previews and reuses the full data URL", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pointer-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const view = render(
      <TestQueryProvider>
        <AssetProbe source="file-service://asset-1" />
      </TestQueryProvider>,
    );

    expect(view.getByTestId("status").textContent).toBe("loading");
    await waitFor(() => {
      expect(view.getByTestId("preview").textContent).toBe("blob:pointer-preview");
    });
    expect(view.getByTestId("status").textContent).toBe("ready");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Materialize" }));
    });
    await waitFor(() => {
      expect(view.getByTestId("materialized").textContent).toBe("data:image/webp;base64,BAUG");
    });
    expect(invokeCalls.map(([channel]) => channel)).toEqual([
      "codex:conversation-image-asset:resolve",
    ]);
  });

  test("shares pointer previews across consumers without releasing them on unmount", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-preview");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const client = createTestQueryClient();
    const view = render(
      <TestQueryProvider client={client}>
        <AssetProbe key="first" source="file-service://asset-1" />
        <AssetProbe key="second" source="file-service://asset-1" />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("preview").map((node) => node.textContent)).toEqual([
        "blob:shared-preview",
        "blob:shared-preview",
      ]);
    });
    view.rerender(
      <TestQueryProvider client={client}>
        <AssetProbe key="second" source="file-service://asset-1" />
      </TestQueryProvider>,
    );
    expect(view.getByTestId("preview").textContent).toBe("blob:shared-preview");
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    view.unmount();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    client.clear();
    await waitFor(() => {
      expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith("blob:shared-preview");
    });
  });

  test("replaces a failed remote source with fetched image data on retry", async () => {
    const readResource = vi
      .fn()
      .mockRejectedValueOnce(new Error("Image request failed with status 503"))
      .mockResolvedValueOnce({ contentsBase64: "AQID", mimeType: "image/png" });
    installWindowApi({
      invoke: async (channel: string, input: unknown) => {
        invokeCalls.push([channel, input]);
        if (channel === "native-resource:read") return readResource(input);
        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: () => () => undefined,
    });
    const view = render(
      <TestQueryProvider>
        <AssetProbe source="https://example.test/hero.png" />
      </TestQueryProvider>,
    );

    expect(view.getByTestId("preview").textContent).toBe("https://example.test/hero.png");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => {
      expect(view.getByTestId("status").textContent).toBe("error");
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => {
      expect(view.getByTestId("preview").textContent).toBe("data:image/png;base64,AQID");
    });
    expect(view.getByTestId("status").textContent).toBe("ready");
    expect(invokeCalls).toEqual([
      ["native-resource:read", { url: "https://example.test/hero.png" }],
      ["native-resource:read", { url: "https://example.test/hero.png" }],
    ]);
  });
});
