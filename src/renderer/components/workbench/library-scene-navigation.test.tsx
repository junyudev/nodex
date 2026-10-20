import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";

import { render } from "../../test/dom";
import { TestQueryProvider } from "../../test/query";
import { queryKeys } from "../../lib/query-keys";
import { useLibrarySceneNavigation } from "./library-scene-breadcrumb";

function EmptyLibrarySceneNavigation() {
  const navigation = useLibrarySceneNavigation(null);
  return <output>{navigation.activeSurface ? "active" : "empty"}</output>;
}

describe("Library scene navigation", () => {
  test("does not materialize a placeholder Library query without a target", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const view = render(
      <TestQueryProvider client={queryClient}>
        <EmptyLibrarySceneNavigation />
      </TestQueryProvider>,
    );

    await waitFor(() => expect(view.getByText("empty")).toBeTruthy());
    expect(
      queryClient.getQueryCache().findAll({
        queryKey: queryKeys.library.all(),
      }),
    ).toHaveLength(0);
  });
});
