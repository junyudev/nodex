import type { MutableRefObject } from "react";
import type {
  Card,
  CardInput,
  CardUpdateMutationResult,
  CodexThreadSummary,
} from "@/lib/types";

export interface CardStageLinkedThread {
  threadId: string;
  title: string;
  preview?: string;
  statusType: CodexThreadSummary["statusType"];
  statusActiveFlags: CodexThreadSummary["statusActiveFlags"];
  archived: boolean;
  updatedAt: number;
}

export interface CardStageSessionSnapshot {
  projectId: string;
  cardId: string;
  titleSnapshot: string;
}

export interface CardStageProps {
  onClose: () => void;
  onLeaveCard?: (snapshot: CardStageSessionSnapshot) => void;
  closeRef?: MutableRefObject<(() => Promise<void>) | null>;
  persistRef?: MutableRefObject<(() => Promise<void>) | null>;
  sessionSnapshotRef?: MutableRefObject<CardStageSessionSnapshot | null>;
  card: Card | null;
  columnId: string;
  columnName: string;
  projectId: string;
  projectWorkspacePath?: string | null;
  availableTags: string[];
  onUpdate: (
    columnId: string,
    cardId: string,
    updates: Partial<CardInput>,
  ) => Promise<CardUpdateMutationResult | void>;
  onPatch: (
    columnId: string,
    cardId: string,
    updates: Partial<CardInput>,
  ) => void;
  onDelete: (columnId: string, cardId: string) => Promise<void>;
  onMove: (fromStatus: Card["status"], cardId: string, toStatus: Card["status"]) => Promise<void>;
  onCompleteOccurrence?: (cardId: string, occurrenceStart: Date) => Promise<void>;
  onSkipOccurrence?: (cardId: string, occurrenceStart: Date) => Promise<void>;
  onColumnIdChange?: (columnId: string) => void;
  onOpenTerminalPanel?: () => void;
  onOpenHistoryPanel?: () => void;
  linkedCodexThreads?: CardStageLinkedThread[];
  onOpenCodexThread?: (threadId: string) => Promise<void>;
  onOpenNewCodexThread?: () => void;
  onStartThreadSection?: (input: {
    projectId: string;
    cardId: string;
    prompt: string;
  }) => Promise<{ threadId: string }>;
  onSendThreadSectionPrompt?: (input: {
    projectId: string;
    threadId: string;
    prompt: string;
  }) => Promise<void>;
  terminalPanelActive?: boolean;
  historyPanelActive?: boolean;
}
