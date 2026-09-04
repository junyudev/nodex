import type { RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderWithAppMaitai } from "./app-maitai";
import { TestThreadRouteScopePath } from "./maitai-scope-harness";

/** A fresh application and thread-route scope for tests that exercise thread owners. */
export function renderWithMaitai(ui: ReactElement, options?: RenderOptions) {
  const { wrapper: NestedWrapper, ...renderOptions } = options ?? {};
  return renderWithAppMaitai(ui, {
    ...renderOptions,
    wrapper: ({ children }) => (
      <TestThreadRouteScopePath>
        {NestedWrapper ? <NestedWrapper>{children}</NestedWrapper> : children}
      </TestThreadRouteScopePath>
    ),
  });
}
