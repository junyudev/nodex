import { getIntl, useIntl } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DICTATION_DICTIONARY_MAX_WORD_LENGTH } from "../../../shared/dictation-dictionary";
import { CloseIcon } from "@/components/shared/icons";
import { Input } from "@/components/ui/input";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { createDictationDictionarySession } from "./dictation-dictionary-runtime";

type Mutation =
  | { type: "add"; text: string }
  | { type: "remove"; wordId: string }
  | { type: "import"; words: readonly string[] };

export function DictationDictionaryDialog({ onClose }: { readonly onClose: () => void }) {
  const intl = useIntl();
  const [session] = useState(createDictationDictionarySession);
  const [newWord, setNewWord] = useState("");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<readonly string[] | null>(null);
  useEffect(() => {
    session.activate();
    return () => session.dispose();
  }, [session]);
  // The opaque ID identifies the immutable account-bound session.
  const query = useQuery({
    queryKey: ["dictation-custom-dictionary", session.id],
    queryFn: ({ signal }) => session.read(signal),
    staleTime: 5_000,
    refetchOnWindowFocus: "always",
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async (input: Mutation) => {
      if (input.type === "remove") return session.remove(input.wordId);
      if (input.type === "add") {
        await session.add(input.text);
        setNewWord("");
        return;
      }
      await session.importWords(input.words);
      setSelection(null);
    },
    onSettled: async () => {
      await query.refetch();
    },
    onError: (error) => {
      if (error.name === "AbortError") return;
      toast.danger(
        getIntl().formatMessage({
          id: "dictation.dictationDictionaryDialog.saveFailed",
          defaultMessage: "Couldn’t save dictionary changes. Check the words and try again",
        }),
      );
    },
  });
  const blocked = query.isPending || query.isError || mutation.isPending;
  const full = query.data !== undefined && query.data.words.length >= query.data.maxWords;
  const localWords = query.data?.localWords ?? [];
  const words =
    query.data?.words.filter((word) =>
      word.text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
    ) ?? [];
  const close = () => {
    session.dispose();
    onClose();
  };

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <NodexDialogContent size="wide">
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            if (blocked) return;
            if (selection) {
              if (selection.length) mutation.mutate({ type: "import", words: selection });
              return;
            }
            if (!full && newWord.trim()) mutation.mutate({ type: "add", text: newWord.trim() });
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>
              {intl.formatMessage({
                id: "dictation.dictationDictionaryDialog.title",
                defaultMessage: "Voice dictionary",
              })}
            </NodexDialogTitle>
            <NodexDialogDescription className="sr-only">
              {intl.formatMessage({
                id: "dictation.dictationDictionaryDialog.description",
                defaultMessage: "Manage words recognized during dictation.",
              })}
            </NodexDialogDescription>
          </NodexDialogHeader>
          {selection === null ? (
            <NodexDialogBody className="gap-3">
              <label htmlFor="dictionary-new-word" className="text-sm font-medium">
                {intl.formatMessage({
                  id: "dictation.dictationDictionaryDialog.addWord",
                  defaultMessage: "Add word",
                })}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id="dictionary-new-word"
                  autoFocus
                  value={newWord}
                  maxLength={DICTATION_DICTIONARY_MAX_WORD_LENGTH}
                  disabled={blocked || full}
                  onChange={(event) => setNewWord(event.target.value)}
                  placeholder={intl.formatMessage({
                    id: "dictation.dictationDictionaryDialog.wordPlaceholder",
                    defaultMessage: "Word ChatGPT should recognize when spoken",
                  })}
                />
                <NodexDialogAction
                  type="submit"
                  tone="primary"
                  disabled={blocked || full || !newWord.trim()}
                >
                  {intl.formatMessage({
                    id: "dictation.dictationDictionaryDialog.add",
                    defaultMessage: "Add",
                  })}
                </NodexDialogAction>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">
                  {intl.formatMessage({
                    id: "dictation.dictationDictionaryDialog.words",
                    defaultMessage: "Words",
                  })}
                </span>
                {query.data && (
                  <span className="text-token-description-foreground">
                    {query.data.words.length}/{query.data.maxWords}
                  </span>
                )}
              </div>
              <Input
                aria-label={intl.formatMessage({
                  id: "dictation.dictationDictionaryDialog.search",
                  defaultMessage: "Search words",
                })}
                placeholder={intl.formatMessage({
                  id: "dictation.dictationDictionaryDialog.search",
                  defaultMessage: "Search words",
                })}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="max-h-72 min-h-24 overflow-y-auto">
                {query.isPending ? (
                  <p role="status" className="py-4 text-sm text-token-description-foreground">
                    {intl.formatMessage({
                      id: "dictation.dictationDictionaryDialog.loading",
                      defaultMessage: "Loading words…",
                    })}
                  </p>
                ) : query.isError ? (
                  <div className="flex items-center justify-between gap-3 py-4">
                    <p role="alert" className="text-sm">
                      {intl.formatMessage({
                        id: "dictation.dictationDictionaryDialog.loadFailed",
                        defaultMessage: "We couldn’t load your saved words",
                      })}
                    </p>
                    <NodexDialogAction
                      disabled={query.isFetching}
                      onClick={() => {
                        void query.refetch();
                      }}
                    >
                      {intl.formatMessage({
                        id: "dictation.dictationDictionaryDialog.retry",
                        defaultMessage: "Retry",
                      })}
                    </NodexDialogAction>
                  </div>
                ) : words.length === 0 ? (
                  <p className="py-4 text-sm text-token-description-foreground">
                    {search.trim()
                      ? intl.formatMessage({
                          id: "dictation.dictationDictionaryDialog.noMatches",
                          defaultMessage: "No matching words",
                        })
                      : intl.formatMessage({
                          id: "dictation.dictationDictionaryDialog.empty",
                          defaultMessage: "No words yet",
                        })}
                  </p>
                ) : (
                  <ul className="divide-y divide-token-border">
                    {words.map((word) => (
                      <li
                        key={word.id}
                        className="flex items-center justify-between gap-3 py-2 text-sm"
                      >
                        <span className="min-w-0 select-text break-words">{word.text}</span>
                        <NodexDialogAction
                          aria-label={intl.formatMessage(
                            {
                              id: "dictation.dictationDictionaryDialog.removeWord",
                              defaultMessage: "Remove {word}",
                            },
                            { word: word.text },
                          )}
                          size="compact"
                          disabled={mutation.isPending}
                          onClick={() => mutation.mutate({ type: "remove", wordId: word.id })}
                        >
                          <CloseIcon className="size-3.5" />
                        </NodexDialogAction>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {localWords.length > 0 && (
                <NodexDialogAction
                  className="self-start"
                  disabled={blocked}
                  onClick={() => setSelection([...new Set(localWords)])}
                >
                  {intl.formatMessage({
                    id: "dictation.dictationDictionaryDialog.importAction",
                    defaultMessage: "Import words from this device…",
                  })}
                </NodexDialogAction>
              )}
            </NodexDialogBody>
          ) : (
            <NodexDialogBody className="gap-3">
              <p className="text-sm text-token-description-foreground">
                {intl.formatMessage({
                  id: "dictation.dictationDictionaryDialog.importDescription",
                  defaultMessage:
                    "Import these words from this device into your current account and workspace. Saved words will be available on your other devices.",
                })}
              </p>
              <div className="max-h-72 overflow-y-auto divide-y divide-token-border">
                {localWords.map((word) => (
                  <label
                    key={word}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="min-w-0 select-text break-words">{word}</span>
                    <input
                      type="checkbox"
                      aria-label={word}
                      checked={selection.includes(word)}
                      disabled={mutation.isPending}
                      onChange={(event) =>
                        setSelection(
                          event.target.checked
                            ? [...selection, word]
                            : selection.filter((selected) => selected !== word),
                        )
                      }
                    />
                  </label>
                ))}
              </div>
              <NodexDialogFooter>
                <NodexDialogAction disabled={mutation.isPending} onClick={() => setSelection(null)}>
                  {intl.formatMessage({
                    id: "dictation.dictationDictionaryDialog.cancel",
                    defaultMessage: "Cancel",
                  })}
                </NodexDialogAction>
                <NodexDialogAction
                  type="submit"
                  tone="primary"
                  disabled={blocked || selection.length === 0}
                >
                  {intl.formatMessage({
                    id: "dictation.dictationDictionaryDialog.importWords",
                    defaultMessage: "Import words",
                  })}
                </NodexDialogAction>
              </NodexDialogFooter>
            </NodexDialogBody>
          )}
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}
