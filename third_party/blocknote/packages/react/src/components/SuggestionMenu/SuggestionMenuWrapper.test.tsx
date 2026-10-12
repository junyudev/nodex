import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { GridSuggestionMenuWrapper } from "./GridSuggestionMenu/GridSuggestionMenuWrapper.js";
import { SuggestionMenuWrapper } from "./SuggestionMenuWrapper.js";

const mocks = vi.hoisted(() => ({
  selectedIndex: undefined as number | undefined,
  setContentEditableProps: vi.fn(),
}));

vi.mock("../../editor/BlockNoteContext.js", () => ({
  useBlockNoteContext: () => ({
    setContentEditableProps: mocks.setContentEditableProps,
  }),
}));

vi.mock("../../hooks/useBlockNoteEditor.js", () => ({
  useBlockNoteEditor: () => ({
    getExtension: () => ({
      getMenuState: () => ({ triggerCharacter: "/", query: "", show: true }),
    }),
  }),
}));

vi.mock("./hooks/useLoadSuggestionMenuItems.js", () => ({
  useLoadSuggestionMenuItems: () => ({
    items: ["first", "second", "third"],
    usedQuery: "",
    loadingState: "loaded",
  }),
}));

vi.mock("./hooks/useCloseSuggestionMenuNoItems.js", () => ({
  useCloseSuggestionMenuNoItems: () => undefined,
}));

vi.mock("./hooks/useSuggestionMenuKeyboardNavigation.js", () => ({
  useSuggestionMenuKeyboardNavigation: () => ({
    selectedIndex: mocks.selectedIndex,
  }),
}));

vi.mock(
  "./GridSuggestionMenu/hooks/useGridSuggestionMenuKeyboardNavigation.js",
  () => ({
    useGridSuggestionMenuKeyboardNavigation: () => ({
      selectedIndex: mocks.selectedIndex,
    }),
  }),
);

type ContentEditableProps = {
  "aria-activedescendant"?: string;
  "aria-controls"?: string;
  "aria-expanded"?: boolean;
};

let container: HTMLDivElement;
let root: Root;
let contentEditableProps: ContentEditableProps;
const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  contentEditableProps = {};
  mocks.selectedIndex = undefined;
  mocks.setContentEditableProps.mockImplementation(
    (update: (props: ContentEditableProps) => ContentEditableProps) => {
      contentEditableProps = update(contentEditableProps);
    },
  );
});

afterEach(async () => {
  try {
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.clearAllMocks();
    if (previousActEnvironment === undefined) {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    } else {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
    }
  }
});

function Menu() {
  return null;
}

function renderWrapper(type: "list" | "grid") {
  const commonProps = {
    triggerCharacter: "/",
    query: "",
    closeMenu: vi.fn(),
    acceptMenu: vi.fn(() => true),
    getItems: async () => ["first", "second", "third"],
  };

  return act(async () => {
    root.render(
      type === "list" ? (
        <SuggestionMenuWrapper
          {...commonProps}
          suggestionMenuComponent={Menu}
        />
      ) : (
        <GridSuggestionMenuWrapper
          {...commonProps}
          columns={2}
          gridSuggestionMenuComponent={Menu}
        />
      ),
    );
  });
}

describe.each(["list", "grid"] as const)(
  "%s suggestion menu wrapper",
  (type) => {
    it("updates and clears aria-activedescendant", async () => {
      mocks.selectedIndex = 0;
      await renderWrapper(type);
      expect(contentEditableProps["aria-activedescendant"]).toBe(
        "bn-suggestion-menu-item-0",
      );

      mocks.selectedIndex = 2;
      await renderWrapper(type);
      expect(contentEditableProps["aria-activedescendant"]).toBe(
        "bn-suggestion-menu-item-2",
      );

      mocks.selectedIndex = undefined;
      await renderWrapper(type);
      expect(contentEditableProps["aria-activedescendant"]).toBeUndefined();

      mocks.selectedIndex = 0;
      await renderWrapper(type);
      await act(async () => root.unmount());
      expect(contentEditableProps["aria-activedescendant"]).toBeUndefined();
    });
  },
);
