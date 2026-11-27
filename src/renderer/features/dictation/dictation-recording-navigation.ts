import { createContext, useContext } from "react";

export const DictationRecordingNavigationContext = createContext<
  ((recordingId?: string) => void) | undefined
>(undefined);

export const useDictationRecordingNavigation = () =>
  useContext(DictationRecordingNavigationContext);
