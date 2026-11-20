import { FormattedMessage, getIntl, useIntl } from "@/lib/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { ActivitySpinnerIcon, FolderOpenIcon, PlusIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NodexSegmentedControl } from "@/components/ui/segmented-control";
import { NodexCheckbox } from "@/components/ui/settings";
import { toastFailure } from "@/lib/failure-toast";
import type { Project, ProjectCreateInput } from "@/lib/types";
import type { ProjectCandidateChat } from "../../../shared/project-discovery";
import { localProjectSourceRoots } from "../../../shared/project-sources";
import {
  candidateActivity,
  candidateChoice,
  firstTaskForChoice,
  offeredCandidates,
  type FirstRunCandidateOrder,
  type FirstRunFolderChoice,
  type FirstRunLanding,
} from "./first-run-model";
import {
  FirstRunActionRow,
  FirstRunCard,
  FirstRunCardList,
  FirstRunPrimary,
  FirstRunRow,
  FirstRunTitle,
} from "./first-run-frame";
import {
  chooseProjectFolders,
  importRecentChats,
  useFolderLabel,
  useProjectCandidates,
} from "./first-run-projects";

const projectRoots = (projects: readonly Project[]): ReadonlySet<string> =>
  new Set(projects.flatMap((project) => localProjectSourceRoots(project.sources)));

const folderChoice = (path: string): FirstRunFolderChoice => ({
  key: path,
  kind: "folder",
  name: path.split(/[\\/]/u).findLast(Boolean) ?? path,
  path,
  candidate: null,
});

/** Paths and typed names are not valid ids as they are; encoding keeps each row's id unique. */
const choiceRowId = (prefix: string, key: string) => `${prefix}${encodeURIComponent(key)}`;

/** `owner/name` with the owner quieter, so a list of one person's repositories reads by name. */
function ChoiceName({ choice }: { readonly choice: FirstRunFolderChoice }) {
  const repository = choice.candidate?.repository;
  const slash = repository?.lastIndexOf("/") ?? -1;
  if (!repository || slash <= 0) return choice.name;
  return (
    <>
      <span className="font-normal text-token-text-secondary">
        {repository.slice(0, slash + 1)}
      </span>
      {repository.slice(slash + 1)}
    </>
  );
}

/** Selects every row at once and orders the folders the scan found. */
function ChoiceListHeader({
  selection,
  onSelectAll,
  order,
  onOrderChange,
  disabled,
}: {
  readonly selection: "none" | "some" | "all";
  readonly onSelectAll: (on: boolean) => void;
  /** Absent when there's nothing to put in order. */
  readonly order: FirstRunCandidateOrder | null;
  readonly onOrderChange: (order: FirstRunCandidateOrder) => void;
  readonly disabled: boolean;
}) {
  const intl = useIntl();
  const selectAll = intl.formatMessage({
    id: "firstRun.firstRunProjectsStep.selectAll",
    defaultMessage: "Select all",
  });
  return (
    <div className="flex min-h-10 items-center gap-3 px-3.5 py-1.5">
      <label className="flex min-w-0 flex-1 cursor-interaction items-center gap-3 text-[13px] text-token-text-secondary">
        <NodexCheckbox
          ariaLabel={selectAll}
          className="border-token-foreground/25"
          checked={selection === "all"}
          indeterminate={selection === "some"}
          disabled={disabled}
          onCheckedChange={onSelectAll}
        />
        <span className="truncate">{selectAll}</span>
      </label>
      {order ? (
        <NodexSegmentedControl<FirstRunCandidateOrder>
          size="sm"
          ariaLabel={intl.formatMessage({
            id: "firstRun.firstRunProjectsStep.sortBy",
            defaultMessage: "Sort by",
          })}
          value={order}
          disabled={disabled}
          onChange={onOrderChange}
          options={[
            {
              value: "recent",
              label: intl.formatMessage({
                id: "firstRun.firstRunProjectsStep.mostRecent",
                defaultMessage: "Most recent",
              }),
            },
            {
              value: "chats",
              label: intl.formatMessage({
                id: "firstRun.firstRunProjectsStep.mostChats",
                defaultMessage: "Most chats",
              }),
            },
          ]}
        />
      ) : null}
    </div>
  );
}

/** Adds what it can, one folder at a time, and says which it couldn't. */
async function createChosenProjects(
  choices: readonly FirstRunFolderChoice[],
  onCreateProject: (input: ProjectCreateInput) => Promise<Project | null>,
) {
  const created: { readonly choice: FirstRunFolderChoice; readonly project: Project }[] = [];
  for (const choice of choices) {
    try {
      const project = await onCreateProject({
        name: choice.candidate?.name ?? choice.name,
        sources: choice.path ? [choice.path] : [],
      });
      if (project) created.push({ choice, project });
    } catch (cause) {
      toastFailure(
        getIntl().formatMessage(
          {
            id: "firstRun.firstRunProjectsStep.couldnTAddValue",
            defaultMessage: "Couldn’t add {value1}",
          },
          { value1: choice.name },
        ),
        cause,
      );
    }
  }
  return created;
}

export function FirstRunProjectsStep({
  projects,
  onCreateProject,
  onContinue,
}: {
  readonly projects: readonly Project[];
  readonly onCreateProject: (input: ProjectCreateInput) => Promise<Project | null>;
  readonly onContinue: (landing: FirstRunLanding | null) => void;
}) {
  const intl = useIntl();
  const scan = useProjectCandidates(true);
  const folderLabel = useFolderLabel();
  const [added, setAdded] = useState<readonly FirstRunFolderChoice[]>([]);
  // Null until the person changes something, so a late scan can still preselect its suggestions.
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [bringChats, setBringChats] = useState(false);
  const [namingEmpty, setNamingEmpty] = useState(false);
  const [emptyName, setEmptyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());
  const [order, setOrder] = useState<FirstRunCandidateOrder>("recent");
  // A fresh object each time, so choosing the same folder again still brings it into view.
  const [reveal, setReveal] = useState<{ readonly key: string } | null>(null);
  const rowIdPrefix = useId();
  const list = useRef<HTMLDivElement>(null);

  const roots = projectRoots(projects);
  const candidates = offeredCandidates(scan.data?.candidates ?? [], roots, order);
  // Folders the person added themselves stay on top, whichever order the rest are in.
  const choices = [...added, ...candidates.map(candidateChoice)];
  const selectedKeys =
    picked ??
    new Set([
      ...added.map((choice) => choice.key),
      ...candidates.filter((candidate) => candidate.suggested).map((candidate) => candidate.path),
    ]);
  const selected = choices.filter((choice) => selectedKeys.has(choice.key));
  const chats = selected.flatMap((choice) => choice.candidate?.recentChats ?? []);
  const scanning = scan.isPending;
  const selection =
    selected.length === 0 ? "none" : selected.length === choices.length ? "all" : "some";

  useEffect(() => {
    if (!reveal) return;
    document
      .getElementById(choiceRowId(rowIdPrefix, reveal.key))
      ?.scrollIntoView({ block: "nearest" });
  }, [reveal, rowIdPrefix]);

  const toggle = (key: string, on: boolean) => {
    const next = new Set(selectedKeys);
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  };
  const selectAll = (on: boolean) =>
    setPicked(on ? new Set(choices.map((choice) => choice.key)) : new Set());
  const reorder = (next: FirstRunCandidateOrder) => {
    setOrder(next);
    if (list.current) list.current.scrollTop = 0;
  };
  /** Selects what the person chose, listing what the scan didn't offer on top, and shows it. */
  const include = (keys: readonly string[], unlisted: readonly FirstRunFolderChoice[]) => {
    const first = keys[0];
    if (first === undefined) return;
    setAdded((current) => [
      ...unlisted.filter((choice) => !current.some((entry) => entry.key === choice.key)),
      ...current,
    ]);
    setPicked(new Set([...selectedKeys, ...keys]));
    setReveal({ key: first });
  };
  const addFolders = async () => {
    const folders = (await chooseProjectFolders()).filter((path) => !roots.has(path));
    const listed = new Set(choices.map((choice) => choice.key));
    include(folders, folders.filter((path) => !listed.has(path)).map(folderChoice));
  };
  const addEmpty = () => {
    const name = emptyName.trim();
    if (!name) return;
    const choice: FirstRunFolderChoice = {
      key: `empty:${name}`,
      kind: "empty",
      name,
      path: null,
      candidate: null,
    };
    include([choice.key], [choice]);
    setEmptyName("");
    setNamingEmpty(false);
  };

  const create = async () => {
    setBusy(true);
    const created = await createChosenProjects(selected, onCreateProject);
    setBusy(false);
    const first = created[0];
    if (!first) return;
    if (bringChats) {
      importRecentChats(
        created.flatMap(({ choice, project }) =>
          (choice.candidate?.recentChats ?? []).map((chat: ProjectCandidateChat) => ({
            projectId: project.id,
            chat,
          })),
        ),
      );
    }
    onContinue({ projectId: first.project.id, task: firstTaskForChoice(first.choice) });
  };

  const count = selected.length;
  const hasProjects = projects.length > 0;
  return (
    <>
      <FirstRunTitle
        title={intl.formatMessage({
          id: "firstRun.firstRunProjectsStep.whereShouldAgentsWork",
          defaultMessage: "Where should agents work?",
        })}
        description={
          candidates.length > 0
            ? intl.formatMessage({
                id: "firstRun.firstRunProjectsStep.foundInYourCodexAnd",
                defaultMessage:
                  "Found in your Codex and Claude Code history. Choose any, or add a folder.",
              })
            : intl.formatMessage({
                id: "firstRun.firstRunProjectsStep.chooseAFolderYouAlready",
                defaultMessage: "Choose a folder you already work in, or start an empty project.",
              })
        }
      />
      <FirstRunCard>
        {choices.length > 1 ? (
          <ChoiceListHeader
            selection={selection}
            onSelectAll={selectAll}
            order={candidates.length > 1 ? order : null}
            onOrderChange={reorder}
            disabled={busy}
          />
        ) : null}
        {scanning || choices.length > 0 ? (
          <FirstRunCardList ref={list} className="max-h-[min(20rem,42vh)]">
            {scanning ? (
              <FirstRunRow
                leading={
                  <ActivitySpinnerIcon className="icon-xs text-token-description-foreground" />
                }
                label={intl.formatMessage({
                  id: "firstRun.firstRunProjectsStep.lookingForYourProjects",
                  defaultMessage: "Looking for your projects",
                })}
                detail={intl.formatMessage({
                  id: "firstRun.firstRunProjectsStep.readingYourHistory",
                  defaultMessage: "Reading your Codex and Claude Code history",
                })}
              />
            ) : null}
            {choices.map((choice) => (
              <FirstRunRow
                key={choice.key}
                id={choiceRowId(rowIdPrefix, choice.key)}
                leading={
                  <NodexCheckbox
                    ariaLabel={choice.name}
                    className="border-token-foreground/25"
                    checked={selectedKeys.has(choice.key)}
                    disabled={busy}
                    onCheckedChange={(checked) => toggle(choice.key, checked)}
                  />
                }
                label={<ChoiceName choice={choice} />}
                detail={
                  choice.candidate
                    ? `${candidateActivity(choice.candidate, now, intl)} · ${choice.candidate.displayPath}`
                    : choice.path
                      ? folderLabel(choice.path)
                      : intl.formatMessage({
                          id: "firstRun.firstRunProjectsStep.newProjectFolder",
                          defaultMessage: "A new folder in your Nodex projects",
                        })
                }
              />
            ))}
          </FirstRunCardList>
        ) : null}
        <FirstRunActionRow
          icon={<FolderOpenIcon className="icon-xs text-token-description-foreground" />}
          label={intl.formatMessage({
            id: "firstRun.firstRunProjectsStep.chooseAFolder",
            defaultMessage: "Choose a folder",
          })}
          disabled={busy}
          onClick={() =>
            void addFolders().catch((cause: unknown) =>
              toastFailure(
                intl.formatMessage({
                  id: "firstRun.firstRunProjectsStep.couldnTOpenTheFolder",
                  defaultMessage: "Couldn’t open the folder picker",
                }),
                cause,
              ),
            )
          }
        />
        {namingEmpty ? (
          <form
            className="flex items-center gap-2 px-3.5 py-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              addEmpty();
            }}
          >
            <PlusIcon className="icon-xs shrink-0 text-token-description-foreground" />
            <Input
              aria-label={intl.formatMessage({
                id: "firstRun.firstRunProjectsStep.projectName",
                defaultMessage: "Project name",
              })}
              autoFocus
              className="h-8 flex-1 text-sm"
              placeholder={intl.formatMessage({
                id: "firstRun.firstRunProjectsStep.projectName",
                defaultMessage: "Project name",
              })}
              value={emptyName}
              onChange={(event) => setEmptyName(event.target.value)}
            />
            <NodexButton size="sm" variant="secondary" disabled={!emptyName.trim()} type="submit">
              <FormattedMessage id="firstRun.firstRunProjectsStep.add" defaultMessage="Add" />
            </NodexButton>
          </form>
        ) : (
          <FirstRunActionRow
            icon={<PlusIcon className="icon-xs text-token-description-foreground" />}
            label={intl.formatMessage({
              id: "firstRun.firstRunProjectsStep.startAnEmptyProject",
              defaultMessage: "Start an empty project",
            })}
            disabled={busy}
            onClick={() => setNamingEmpty(true)}
          />
        )}
      </FirstRunCard>
      {chats.length > 0 ? (
        <label className="mt-3 flex cursor-interaction items-start gap-2.5 px-3.5 text-left">
          <NodexCheckbox
            ariaLabel={intl.formatMessage({
              id: "firstRun.firstRunProjectsStep.importRecent",
              defaultMessage: "Also bring recent chats",
            })}
            className="mt-0.5"
            checked={bringChats}
            disabled={busy}
            onCheckedChange={setBringChats}
          />
          <span className="min-w-0">
            <span className="block text-sm text-token-text-primary">
              {intl.formatMessage(
                {
                  id: "firstRun.firstRunProjectsStep.importCount",
                  defaultMessage: "Also bring recent chats ({count})",
                },
                { count: chats.length },
              )}
            </span>
            <span className="block text-xs text-token-description-foreground">
              <FormattedMessage
                id="firstRun.firstRunProjectsStep.copiesFromTheLast30"
                defaultMessage="Copies from the last 30 days. The originals stay as they are."
              />
            </span>
          </span>
        </label>
      ) : null}
      <FirstRunPrimary
        disabled={busy || (count === 0 && !hasProjects)}
        onClick={() => (count > 0 ? void create() : onContinue(null))}
        secondary={
          hasProjects ? null : (
            <NodexButton
              variant="ghostSecondary"
              disabled={busy}
              onClick={() => onContinue({ projectId: null, task: "no-project" })}
            >
              <FormattedMessage
                id="firstRun.firstRunProjectsStep.justChatForNow"
                defaultMessage="Just chat for now"
              />
            </NodexButton>
          )
        }
      >
        {count === 0
          ? intl.formatMessage({ id: "firstRun.firstRunProjectsStep.done", defaultMessage: "Done" })
          : count === 1
            ? intl.formatMessage({
                id: "firstRun.firstRunProjectsStep.addProject",
                defaultMessage: "Add project",
              })
            : intl.formatMessage(
                {
                  id: "firstRun.firstRunProjectsStep.addValueProjects",
                  defaultMessage: "Add {value1} projects",
                },
                { value1: count },
              )}
      </FirstRunPrimary>
    </>
  );
}
