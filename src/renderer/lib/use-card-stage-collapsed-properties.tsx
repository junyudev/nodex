import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  readCardStageCollapsedProperties,
  toggleCardStageCollapsedProperty,
  writeCardStageCollapsedProperties,
  type CardStageCollapsibleProperty,
} from "./card-stage-collapsed-properties";

interface CardStageCollapsedPropertiesContextValue {
  collapsedProperties: CardStageCollapsibleProperty[];
  setCollapsedProperties: (value: CardStageCollapsibleProperty[]) => void;
  toggleCollapsedProperty: (value: CardStageCollapsibleProperty) => void;
}

const CardStageCollapsedPropertiesContext = createContext<CardStageCollapsedPropertiesContextValue>({
  collapsedProperties: readCardStageCollapsedProperties(),
  setCollapsedProperties: () => {},
  toggleCollapsedProperty: () => {},
});

function useCardStageCollapsedPropertiesInternal(): CardStageCollapsedPropertiesContextValue {
  const [collapsedProperties, setCollapsedPropertiesState] = useState<CardStageCollapsibleProperty[]>(() =>
    readCardStageCollapsedProperties(),
  );

  const setCollapsedProperties = useCallback((value: CardStageCollapsibleProperty[]) => {
    const next = writeCardStageCollapsedProperties(value);
    setCollapsedPropertiesState(next);
  }, []);

  const toggleCollapsedProperty = useCallback((value: CardStageCollapsibleProperty) => {
    setCollapsedPropertiesState((current) => {
      const next = toggleCardStageCollapsedProperty(current, value);
      writeCardStageCollapsedProperties(next);
      return next;
    });
  }, []);

  return {
    collapsedProperties,
    setCollapsedProperties,
    toggleCollapsedProperty,
  };
}

export function CardStageCollapsedPropertiesProvider({ children }: { children: ReactNode }) {
  const value = useCardStageCollapsedPropertiesInternal();

  return (
    <CardStageCollapsedPropertiesContext.Provider value={value}>
      {children}
    </CardStageCollapsedPropertiesContext.Provider>
  );
}

export function useCardStageCollapsedProperties(): CardStageCollapsedPropertiesContextValue {
  return useContext(CardStageCollapsedPropertiesContext);
}
