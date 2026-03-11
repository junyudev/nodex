import { useForm, useStore } from "@tanstack/react-form";
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { Board, Project } from "@/lib/types";
import { invoke } from "@/lib/api";
import { handleFormSubmit, resolveFormErrorMessage } from "@/lib/forms";
import { normalizeProjectIcon } from "@/lib/project-icon";
import { useProjects } from "@/lib/use-projects";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import type { SendBlocksMode } from "./nfm-drag-handle-menu";

interface AppendTarget {
  projectId: string;
  columnId: string;
  cardId: string;
}

interface ProjectTarget {
  projectId: string;
  columnId: string;
}

interface SendBlocksDialogProps {
  open: boolean;
  mode: SendBlocksMode;
  blockCount: number;
  sourceProjectId: string;
  sourceCardId: string;
  onOpenChange: (open: boolean) => void;
  onAppendToCard: (target: AppendTarget) => Promise<void>;
  onSendToProject: (target: ProjectTarget) => Promise<void>;
}

interface CardListItem {
  cardId: string;
  title: string;
  columnId: string;
  columnName: string;
}

function resolveDefaultProjectId(
  projects: Project[],
  sourceProjectId: string,
): string {
  if (projects.some((project) => project.id === sourceProjectId)) return sourceProjectId;
  return projects[0]?.id ?? sourceProjectId;
}

function filterCards(
  cards: CardListItem[],
  query: string,
): CardListItem[] {
  if (!query.trim()) return cards.slice(0, 60);
  const normalizedQuery = query.toLowerCase();
  return cards
    .filter((card) => {
      const haystack = `${card.title} ${card.columnName}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .slice(0, 60);
}

export function SendBlocksDialog({
  open,
  mode,
  blockCount,
  sourceProjectId,
  sourceCardId,
  onOpenChange,
  onAppendToCard,
  onSendToProject,
}: SendBlocksDialogProps) {
  const { projects, loading: projectsLoading } = useProjects();
  const [boardMap, setBoardMap] = useState<Map<string, Board>>(new Map());
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: {
      targetProjectId: sourceProjectId,
      targetCardId: "",
      targetStatus: "",
      cardQuery: "",
    },
    onSubmit: async ({ value }) => {
      if (submitting) return;
      setError(null);

      setSubmitting(true);
      try {
        if (mode === "card") {
          const nextSelectedCard = availableCards.find((card) => card.cardId === value.targetCardId);
          if (!nextSelectedCard) return;
          await onAppendToCard({
            projectId: value.targetProjectId,
            columnId: nextSelectedCard.columnId,
            cardId: nextSelectedCard.cardId,
          });
        } else {
          if (!value.targetStatus) return;
          await onSendToProject({
            projectId: value.targetProjectId,
            columnId: value.targetStatus,
          });
        }

        onOpenChange(false);
      } catch (submissionError) {
        setError(resolveFormErrorMessage(submissionError) ?? "Unable to move blocks.");
      } finally {
        setSubmitting(false);
      }
    },
  });
  const formValues = useStore(form.store, (state) => state.values);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const run = async () => {
      setBoardsLoading(true);
      try {
        const results = await Promise.all(
          projects.map(async (project) => {
            const board = (await invoke("board:get", project.id)) as Board;
            return [project.id, board] as const;
          }),
        );
        if (cancelled) return;
        setBoardMap(new Map(results));
      } catch {
        if (cancelled) return;
        setError("Unable to load projects and cards.");
      } finally {
        if (cancelled) return;
        setBoardsLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [open, projects]);

  useEffect(() => {
    if (!open) return;
    form.reset({
      targetProjectId: resolveDefaultProjectId(projects, sourceProjectId),
      targetCardId: "",
      targetStatus: "",
      cardQuery: "",
    });
    setSubmitting(false);
    setError(null);
  }, [form, mode, open, projects, sourceProjectId]);

  const selectedBoard = boardMap.get(formValues.targetProjectId);

  const availableCards = useMemo(() => {
    if (!selectedBoard) return [];
    const result: CardListItem[] = [];
    for (const column of selectedBoard.columns) {
      for (const card of column.cards) {
        if (formValues.targetProjectId === sourceProjectId && card.id === sourceCardId) continue;
        result.push({
          cardId: card.id,
          title: card.title || "Untitled",
          columnId: column.id,
          columnName: column.name,
        });
      }
    }
    return result;
  }, [formValues.targetProjectId, selectedBoard, sourceCardId, sourceProjectId]);

  const filteredCards = useMemo(
    () => filterCards(availableCards, formValues.cardQuery),
    [availableCards, formValues.cardQuery],
  );

  useEffect(() => {
    if (mode !== "card") return;
    if (formValues.targetCardId && availableCards.some((card) => card.cardId === formValues.targetCardId)) return;
    form.setFieldValue("targetCardId", availableCards[0]?.cardId ?? "");
  }, [availableCards, form, formValues.targetCardId, mode]);

  useEffect(() => {
    if (mode !== "project") return;
    const columns = selectedBoard?.columns ?? [];
    if (formValues.targetStatus && columns.some((column) => column.id === formValues.targetStatus)) return;
    form.setFieldValue("targetStatus", columns[0]?.id ?? "");
  }, [form, formValues.targetStatus, mode, selectedBoard]);

  const targetProject = projects.find((project) => project.id === formValues.targetProjectId);
  const targetProjectIcon = normalizeProjectIcon(targetProject?.icon);

  const selectedCard = availableCards.find((card) => card.cardId === formValues.targetCardId);
  const canSubmitAppend = Boolean(selectedCard && !boardsLoading && !projectsLoading);
  const canSubmitProject = Boolean(formValues.targetStatus && !boardsLoading && !projectsLoading);

  const submitLabel = mode === "card" ? "Append blocks" : "Create cards";

  const title = mode === "card" ? "Append blocks to card" : "Turn blocks into cards";
  const description = mode === "card"
    ? `Move ${blockCount} selected block${blockCount === 1 ? "" : "s"} into another card.`
    : `Create ${blockCount} card${blockCount === 1 ? "" : "s"} from the selected blocks.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-140 gap-3">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form
          id="send-blocks-form"
          className="space-y-3"
          onSubmit={(event) => handleFormSubmit(event, form.handleSubmit)}
        >
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-(--foreground-secondary)">
              Destination project
            </p>
            <Select
              value={formValues.targetProjectId}
              onValueChange={(value) => {
                form.setFieldValue("targetProjectId", value);
                form.setFieldValue("targetCardId", "");
                form.setFieldValue("targetStatus", "");
                form.setFieldValue("cardQuery", "");
              }}
            >
              <SelectTrigger className="h-8 w-full">
                <span className="truncate text-sm">
                  {targetProjectIcon
                    ? `${targetProjectIcon} ${targetProject?.name ?? formValues.targetProjectId}`
                    : targetProject?.name ?? formValues.targetProjectId}
                </span>
              </SelectTrigger>
              <SelectContent sideOffset={6}>
                {projects.map((project) => {
                  const icon = normalizeProjectIcon(project.icon);
                  return (
                    <SelectItem key={project.id} value={project.id}>
                      {icon ? `${icon} ${project.name}` : project.name}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {mode === "card" ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-(--foreground-secondary)">
                Destination card
              </p>
              <div className="rounded-md border border-(--border) bg-(--card)">
                <label className="flex items-center gap-2 border-b border-(--border) px-2.5 py-2">
                  <Search className="size-3.5 text-(--foreground-tertiary)" />
                  <input
                    type="text"
                    value={formValues.cardQuery}
                    onChange={(event) => form.setFieldValue("cardQuery", event.target.value)}
                    placeholder="Find card by title or column..."
                    className="h-5 w-full border-none bg-transparent text-sm text-(--foreground) outline-none placeholder:text-(--foreground-tertiary)"
                  />
                </label>
                <div className="max-h-55 overflow-y-auto p-1.5">
                  {boardsLoading && (
                    <p className="px-2 py-3 text-center text-xs text-(--foreground-tertiary)">
                      Loading cards...
                    </p>
                  )}
                  {!boardsLoading && filteredCards.length === 0 && (
                    <p className="px-2 py-3 text-center text-xs text-(--foreground-tertiary)">
                      No matching cards.
                    </p>
                  )}
                  {!boardsLoading && filteredCards.map((card) => {
                    const selected = card.cardId === formValues.targetCardId;
                    return (
                      <button
                        key={`${card.columnId}:${card.cardId}`}
                        type="button"
                        className={cn(
                          "w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                          selected
                            ? "border-(--accent-blue) bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)]"
                            : "border-transparent hover:border-(--border) hover:bg-(--background-secondary)",
                        )}
                        onClick={() => form.setFieldValue("targetCardId", card.cardId)}
                      >
                        <p className="truncate text-sm font-medium text-(--foreground)">
                          {card.title}
                        </p>
                        <p className="truncate text-xs text-(--foreground-tertiary)">
                          {card.columnName}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-(--foreground-secondary)">
                Destination column
              </p>
              <Select value={formValues.targetStatus} onValueChange={(value) => form.setFieldValue("targetStatus", value)}>
                <SelectTrigger className="h-8 w-full">
                  <span className="truncate text-sm">
                    {selectedBoard?.columns.find((column) => column.id === formValues.targetStatus)?.name ?? "Select column"}
                  </span>
                </SelectTrigger>
                <SelectContent sideOffset={6}>
                  {(selectedBoard?.columns ?? []).map((column) => (
                    <SelectItem key={column.id} value={column.id}>
                      {column.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-(--foreground-tertiary)">
                Selected blocks become new cards and are removed from the source card.
              </p>
            </div>
          )}

          {error && (
            <p className="rounded-md border border-(--destructive)/40 bg-(--destructive)/10 px-2.5 py-2 text-xs text-(--destructive)">
              {error}
            </p>
          )}
        </form>

        <DialogFooter className="mt-1">
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-md border border-(--border) px-3 text-sm text-(--foreground-secondary) transition-colors hover:bg-(--background-secondary)"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="send-blocks-form"
            className={cn(
              "inline-flex h-8 items-center rounded-md px-3 text-sm text-white transition-filter",
              "bg-(--accent-blue)",
              "hover:brightness-110",
              "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:brightness-100",
            )}
            disabled={submitting || (mode === "card" ? !canSubmitAppend : !canSubmitProject)}
          >
            {submitting ? "Moving..." : submitLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
