import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import "@excalidraw/excalidraw/index.css";
import { useCanvasState } from "@/lib/use-canvas-state";
import { useKanban } from "@/lib/use-kanban";
import { useTheme } from "@/lib/use-theme";
import {
  createCardElement,
  isCardElement,
  getCardIdFromElement,
  updateCardElements,
} from "@/lib/canvas-card-elements";
import { CanvasCardSidebar } from "./canvas-card-sidebar";
import type { Card } from "@/lib/types";
import { LayoutGrid } from "lucide-react";

const ExcalidrawLazy = lazy(async () => {
  const mod = await import("@excalidraw/excalidraw");
  return { default: mod.Excalidraw };
});

// Lazy-load convertToExcalidrawElements alongside Excalidraw
const convertPromise = import("@excalidraw/excalidraw").then(
  (mod) => mod.convertToExcalidrawElements,
);

interface CanvasViewProps {
  projectId: string;
  openCardStage: (
    projectId: string,
    cardId: string,
    titleSnapshot?: string,
  ) => void;
  cardStageCardId: string | undefined;
  cardStageCloseRef: React.RefObject<(() => Promise<void>) | null>;
}

export function CanvasView({ projectId, openCardStage, cardStageCardId, cardStageCloseRef }: CanvasViewProps) {
  const { initialData, isLoading, saveCanvas } = useCanvasState({ projectId });
  const {
    board,
    createCard,
  } = useKanban({ projectId });
  const { resolved: themeResolved } = useTheme();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [excalidrawAPI, setExcalidrawAPI] = useState<any>(null);
  // Bumped after local scene mutations so placedCardIds recomputes
  const [sceneVersion, setSceneVersion] = useState(0);

  // Track which cards are already placed on the canvas
  const placedCardIds = useMemo(() => {
    if (!excalidrawAPI) return new Set<string>();
    const elements = excalidrawAPI.getSceneElements() as Record<string, unknown>[];
    const ids = new Set<string>();
    for (const el of elements) {
      const cardId = getCardIdFromElement(el);
      if (cardId) ids.add(cardId);
    }
    return ids;
  }, [excalidrawAPI, board, sceneVersion]);

  // Sync card labels when board changes
  useEffect(() => {
    if (!excalidrawAPI || !board) return;
    const elements = excalidrawAPI.getSceneElements() as Record<string, unknown>[];
    const updated = updateCardElements(elements, board);
    if (updated) {
      excalidrawAPI.updateScene({ elements: updated });
      setSceneVersion((v) => v + 1);
    }
  }, [excalidrawAPI, board]);

  // Find card + column from board by cardId
  const findCard = useCallback(
    (cardId: string) => {
      if (!board) return null;
      for (const col of board.columns) {
        const card = col.cards.find((c) => c.id === cardId);
        if (card) return { card, columnId: col.id };
      }
      return null;
    },
    [board],
  );

  // Excalidraw renders a native link badge on elements with a `link` property.
  // Clicking that badge fires onLinkOpen — we intercept to open the card-stage.
  const handleLinkOpen = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (element: any, event: any) => {
      if (!isCardElement(element)) return;
      event.preventDefault();

      const cardId = getCardIdFromElement(element);
      if (!cardId) return;

      // Toggle: clicking the already-peeked card closes it (matches board/list behavior)
      if (cardStageCardId === cardId) {
        await cardStageCloseRef.current?.();
        return;
      }

      const found = findCard(cardId);
      if (!found) return;

      openCardStage(projectId, cardId, found.card.title);
    },
    [findCard, openCardStage, projectId, cardStageCloseRef, cardStageCardId],
  );

  // Place an existing card on the canvas
  const handlePlaceCard = useCallback(
    async (card: Card, columnId: string) => {
      if (!excalidrawAPI) return;
      const convert = await convertPromise;

      const skeleton = createCardElement(card, columnId, {
        x: 100 + Math.random() * 300,
        y: 100 + Math.random() * 300,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const elements = convert([skeleton as any]);
      const existing = excalidrawAPI.getSceneElements();
      excalidrawAPI.updateScene({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        elements: [...existing, ...elements] as any,
      });
      setSceneVersion((v) => v + 1);
    },
    [excalidrawAPI],
  );

  // Create a new card and place it on canvas
  const handleCreateAndPlace = useCallback(async () => {
    if (!excalidrawAPI) return;
    const card = await createCard("draft", { title: "New Card" });
    if (!card) return;
    await handlePlaceCard(card, "draft");
  }, [excalidrawAPI, createCard, handlePlaceCard]);

  // onChange handler: debounced save
  const handleChange = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (elements: readonly any[], appState: any, files: Record<string, unknown>) => {
      saveCanvas(elements, appState, files);
    },
    [saveCanvas],
  );

  // Render top-right UI: card sidebar toggle button
  const renderTopRightUI = useCallback(() => {
    return (
      <button
        onClick={() => excalidrawAPI?.toggleSidebar({ name: "cards", tab: "browse" })}
        className="excalidraw-button"
        title="Cards"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 10px",
          fontSize: 13,
        }}
      >
        <LayoutGrid size={16} />
        Cards
      </button>
    );
  }, [excalidrawAPI]);

  if (isLoading || !initialData) {
    return (
      <div className="flex h-full flex-1 items-center justify-center">
        <div className="text-sm text-(--foreground-secondary)">Loading canvas...</div>
      </div>
    );
  }

  return (
    <div style={{ height: "calc(100vh - 140px)", width: "100%" }}>
      <Suspense
        fallback={
          <div className="flex h-full flex-1 items-center justify-center">
            <div className="text-sm text-(--foreground-secondary)">Loading Excalidraw...</div>
          </div>
        }
      >
        <ExcalidrawLazy
          excalidrawAPI={(api) => setExcalidrawAPI(api)}
          initialData={{
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            elements: initialData.elements as any,
            appState: {
              ...initialData.appState,
              theme: themeResolved,
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            files: initialData.files as any,
          }}
          theme={themeResolved}
          onChange={handleChange}
          onLinkOpen={handleLinkOpen}
          renderTopRightUI={renderTopRightUI}
          UIOptions={{
            canvasActions: {
              loadScene: false,
            },
          }}
        >
          <CanvasCardSidebar
            board={board}
            placedCardIds={placedCardIds}
            onPlaceCard={handlePlaceCard}
            onCreateAndPlace={handleCreateAndPlace}
          />
        </ExcalidrawLazy>
      </Suspense>
    </div>
  );
}
