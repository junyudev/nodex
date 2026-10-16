import { lazy, type ComponentProps } from "react";
import { ApplicationSurface } from "@/bootstrap/application-surface";

const TerminalPanelView = lazy(async () => ({
  default: (await import("../board/terminal-panel")).TerminalPanel,
}));

export function TerminalPanel(props: ComponentProps<typeof TerminalPanelView>) {
  return (
    <ApplicationSurface>
      <TerminalPanelView {...props} />
    </ApplicationSurface>
  );
}
