import { FormattedMessage, getIntl, useIntl } from "@/lib/i18n";
import { useState } from "react";
import { ActivitySpinnerIcon, FolderOpenIcon, PlusIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  type FirstRunFolderChoice,
  type FirstRunLanding,
} from "./first-run-model";
import {
  FirstRunActionRow,
  FirstRunCard,
  FirstRunPrimary,
  FirstRunRow,
  FirstRunTitle,
} from "./first-run-frame";
import {
  chooseProjectFolders,
  importRecentChats,
  useProjectCandidates,
} from "./first-run-projects";

const projectRoots = (projects: readonly Project[]): ReadonlySet<string> =>
  new Set(projects.flatMap((project) => localProjectSourceRoots(project.sources)));

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
  const [added, setAdded] = useState<readonly FirstRunFolderChoice[]>([]);
  // Null until the person changes something, so a late scan can still preselect its suggestions.
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [bringChats, setBringChats] = useState(false);
  const [namingEmpty, setNamingEmpty] = useState(false);
  const [emptyName, setEmptyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());

  const roots = projectRoots(projects);
  const candidates = offeredCandidates(scan.data?.candidates ?? [], roots);
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

  const toggle = (key: string, on: boolean) => {
    const next = new Set(selectedKeys);
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  };
  const includeChoice = (choice: FirstRunFolderChoice) => {
    setAdded((current) =>
      current.some((entry) => entry.key === choice.key) ? current : [choice, ...current],
    );
    setPicked(new Set([...selectedKeys, choice.key]));
  };
  const addFolders = async () => {
    const folders = await chooseProjectFolders();
    for (const path of folders) {
      if (roots.has(path)) continue;
      const known = candidates.find((candidate) => candidate.path === path);
      if (known) {
        setPicked(new Set([...selectedKeys, path]));
        continue;
      }
      includeChoice({
        key: path,
        kind: "folder",
        name: path.split(/[\\/]/u).findLast(Boolean) ?? path,
        path,
        candidate: null,
      });
    }
  };
  const addEmpty = () => {
    const name = emptyName.trim();
    if (!name) return;
    includeChoice({ key: `empty:${name}`, kind: "empty", name, path: null, candidate: null });
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
      <FirstRunCard className="max-h-[min(26rem,52vh)] overflow-y-auto">
        {scanning ? (
          <FirstRunRow
            leading={<ActivitySpinnerIcon className="icon-xs text-token-description-foreground" />}
            label={intl.formatMessage({
              id: "firstRun.firstRunProjectsStep.lookingForYourProjects",
              defaultMessage: "Looking for your projects",
            })}
            detail="Reading your Codex and Claude Code history"
          />
        ) : null}
        {choices.map((choice) => (
          <FirstRunRow
            key={choice.key}
            leading={
              <NodexCheckbox
                ariaLabel={choice.name}
                className="border-token-foreground/25"
                checked={selectedKeys.has(choice.key)}
                disabled={busy}
                onCheckedChange={(checked) => toggle(choice.key, checked)}
              />
            }
            label={choice.name}
            detail={
              choice.candidate
                ? `${candidateActivity(choice.candidate, now, intl)} · ${choice.candidate.displayPath}`
                : (choice.path ??
                  intl.formatMessage({
                    id: "firstRun.firstRunProjectsStep.newProjectFolder",
                    defaultMessage: "A new folder in your Nodex projects",
                  }))
            }
          />
        ))}
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
