import { createContext, useContext, useMemo, type ReactNode } from "react";

export const RIGHT_PANEL_COMPOSER_ACCESSORY_INLINE_INSET_CLASS =
  "mx-[var(--right-panel-composer-accessory-inline-inset,0px)]";

export const RIGHT_PANEL_COMPOSER_ACCESSORY_FROSTED_SURFACE_CLASS =
  "bg-token-input-background/70 backdrop-blur-sm";

/** Whether a composer floats over a full-width pane, and whether it is shown or minimized. */
interface RightPanelComposerPresentationContextValue {
  floating: boolean;
  visible: boolean;
}

const DEFAULT_PRESENTATION: RightPanelComposerPresentationContextValue = {
  floating: false,
  visible: true,
};

const RightPanelComposerPresentationContext =
  createContext<RightPanelComposerPresentationContextValue>(DEFAULT_PRESENTATION);

export function RightPanelComposerPresentationProvider({
  children,
  visible,
}: {
  children: ReactNode;
  visible: boolean;
}) {
  const value = useMemo(() => ({ floating: true, visible }), [visible]);
  return (
    <RightPanelComposerPresentationContext.Provider value={value}>
      {children}
    </RightPanelComposerPresentationContext.Provider>
  );
}

export function useRightPanelComposerPresentation(): RightPanelComposerPresentationContextValue {
  return useContext(RightPanelComposerPresentationContext);
}
