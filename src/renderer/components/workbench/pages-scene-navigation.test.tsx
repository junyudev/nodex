import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";

import { render } from "../../test/dom";
import { TestQueryProvider } from "../../test/query";
import { queryKeys } from "../../lib/query-keys";
import { usePagesSceneNavigation } from "./pages-scene-breadcrumb";

function EmptyPagesSceneNavigation() {
  const navigation = usePagesSceneNavigation(null);
  return <output>{navigation.activeSurface ? "active" : "empty"}</output>;
}

describe("Pages scene navigation", () => {
  test("does not materialize a placeholder Library query without a target", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const view = render(
      <TestQueryProvider client={queryClient}>
        <EmptyPagesSceneNavigation />
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
