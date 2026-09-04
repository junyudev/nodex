import { render, type RenderOptions } from "@testing-library/react";
import { useEffect, type ReactElement, type ReactNode } from "react";
import { MaitaiProvider } from "@/lib/maitai/maitai-scope";
import { createMaitaiStore, disposeMaitaiStore, type MaitaiStore } from "@/lib/maitai/maitai-store";

export function TestMaitaiRoot({
  children,
  store,
}: {
  readonly children: ReactNode;
  readonly store: MaitaiStore;
}) {
  useEffect(() => () => disposeMaitaiStore(store), [store]);
  return <MaitaiProvider store={store}>{children}</MaitaiProvider>;
}

/** A fresh application scope; callers opt into feature scopes through their wrapper. */
export function renderWithAppMaitai(ui: ReactElement, options?: RenderOptions) {
  const store = createMaitaiStore();
  const { wrapper: NestedWrapper, ...renderOptions } = options ?? {};
  return render(ui, {
    ...renderOptions,
    wrapper: ({ children }) => (
      <TestMaitaiRoot store={store}>
        {NestedWrapper ? <NestedWrapper>{children}</NestedWrapper> : children}
      </TestMaitaiRoot>
    ),
  });
}
