import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_CARD_PROPERTY_POSITION,
  readCardPropertyPosition,
  writeCardPropertyPosition,
  type CardPropertyPosition,
} from "./card-property-position";

interface CardPropertyPositionContextValue {
  position: CardPropertyPosition;
  setPosition: (value: CardPropertyPosition) => void;
}

const CardPropertyPositionContext = createContext<CardPropertyPositionContextValue>({
  position: DEFAULT_CARD_PROPERTY_POSITION,
  setPosition: () => {},
});

function useCardPropertyPositionInternal(): CardPropertyPositionContextValue {
  const [position, setPositionState] = useState<CardPropertyPosition>(() =>
    readCardPropertyPosition(),
  );

  const setPosition = useCallback((value: CardPropertyPosition) => {
    const next = writeCardPropertyPosition(value);
    setPositionState(next);
  }, []);

  return { position, setPosition };
}

export function CardPropertyPositionProvider({ children }: { children: ReactNode }) {
  const value = useCardPropertyPositionInternal();
  return (
    <CardPropertyPositionContext.Provider value={value}>
      {children}
    </CardPropertyPositionContext.Provider>
  );
}

export function useCardPropertyPosition(): CardPropertyPositionContextValue {
  return useContext(CardPropertyPositionContext);
}
