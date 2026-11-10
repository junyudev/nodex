import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PAGE_TITLE_TEXT_CLASS_NAME } from "@/components/block-documents/page-title-typography";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { PageEmptyState } from "@/components/ui/section-header";
import { toast } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { WorkspacePierreEditor } from "@/features/workspace-files/workspace-pierre-editor";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { cn } from "@/lib/utils";
import type {
  SkillDocument,
  SkillInventoryContext,
  SkillInventoryEntry,
  SkillLocation,
} from "../../../../shared/skill-inventory";
import { SkillBodyEditor, useSkillEditorSnapshot } from "../skill-body-editor";
import {
  createSkillFileController,
  type SkillFileController,
  type SkillFileSnapshot,
} from "../skill-file-controller";
import { useSkillCommands, useSkillDocument, useSkillInventory } from "../skill-inventory";
import {
  availableSkillSlug,
  displaySkillDirectory,
  displaySkillLocation,
  findSkill,
  skillLocationKind,
  skillSlugFromInput,
} from "../skill-presentation";
import { mountSkillFile } from "../skill-file-lifecycle";
import { SkillActionsMenu } from "./skill-actions-menu";
import { SkillAgentMarks } from "./skill-agent-marks";

export interface SkillPageProps {
  readonly context: SkillInventoryContext;
  readonly skillId: string;
  /** Shows another skill in this page's place, such as the one a rename or a copy produced. */
  readonly onOpenSkill: (skillId: string) => void;
  /** Leaves the page after its skill is deleted or moved away. */
  readonly onClose: () => void;
  readonly onTry?: (skill: SkillInventoryEntry) => void;
  /** Puts the caret in the name, for a skill that was just created. */
  readonly autoFocusName?: boolean;
  readonly className?: string;
  readonly surfaceKey?: string;
  readonly onMetadataChange?: (skill: SkillInventoryEntry) => void;
}

const PAGE_COLUMN_CLASS = "mx-auto w-full max-w-(--page-stage-body-max-width) px-7.5";
const QUIET_FIELD_CLASS =
  "w-full min-w-0 resize-none bg-transparent outline-hidden placeholder:text-(--foreground-disabled)";

function PageMessage({ children }: { readonly children: ReactNode }) {
  return <div className="flex h-full items-center justify-center py-8">{children}</div>;
}

function useSkillFile(
  context: SkillInventoryContext,
  document: SkillDocument,
  surfaceKey?: string,
): { readonly controller: SkillFileController; readonly file: SkillFileSnapshot } {
  const commands = useSkillCommands(context);
  const [controller] = useState(() =>
    createSkillFileController(document, ({ baseRevision, markdown }) =>
      commands.writeDocument({ skillId: document.skillId, baseRevision, markdown }),
    ),
  );
  useEffect(() => {
    controller.observeDisk(document);
  }, [controller, document]);
  useEffect(() => mountSkillFile(controller, surfaceKey), [controller, surfaceKey]);
  const file = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { controller, file };
}

/** One quiet word on where the page's edits stand; nothing while they are simply saved. */
function SaveStatus({ file }: { readonly file: SkillFileSnapshot }) {
  const { save } = file;
  if (file.conflict || save.kind === "saved") return null;
  if (save.kind === "refused" || save.kind === "failed") {
    return (
      <NodexTooltip
        tooltipContent={save.kind === "refused" ? save.reason : save.message}
        side="bottom"
      >
        <span className="text-xs text-danger">Not saved</span>
      </NodexTooltip>
    );
  }
  return (
    <span className="text-xs text-token-description-foreground">
      {save.kind === "saving" ? "Saving…" : "Edited"}
    </span>
  );
}

/** A line across the page for the one thing that needs a decision before editing continues. */
function PageNotice({
  children,
  actions,
}: {
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="mt-3 flex min-h-9 items-center gap-3 rounded-lg bg-token-foreground/5 py-1 ps-3 pe-1 text-sm text-token-text-secondary">
      <span className="min-w-0 flex-1 py-1">{children}</span>
      {actions ? <span className="flex shrink-0 items-center gap-1">{actions}</span> : null}
    </div>
  );
}

function SkillName({
  skill,
  file,
  controller,
  context,
  location,
  autoFocus,
  onOpenSkill,
}: {
  readonly skill: SkillInventoryEntry;
  readonly file: SkillFileSnapshot;
  readonly controller: SkillFileController;
  readonly context: SkillInventoryContext;
  readonly location: SkillLocation;
  readonly autoFocus: boolean;
  readonly onOpenSkill: (skillId: string) => void;
}) {
  const commands = useSkillCommands(context);
  const [draft, setDraft] = useState<string | null>(null);
  const cancelBlur = useRef(false);
  const [renaming, setRenaming] = useState(false);

  const commit = async () => {
    const typed = draft;
    setDraft(null);
    if (typed === null) return;
    const slug = skillSlugFromInput(typed);
    if (slug === null || slug === skill.name) return;
    if (availableSkillSlug(location, slug) !== slug) {
      toast.danger(
        `${displaySkillDirectory(location.directory)} already has a skill named ${slug}`,
      );
      return;
    }
    setRenaming(true);
    await runWithCleanup(
      async () => {
        if (!(await controller.flush())) {
          toast.danger("Save this skill's edits before renaming it");
          return;
        }
        const result = await commands.rename({
          skillId: skill.id,
          baseRevision: controller.getSnapshot().document.revision,
          slug,
        });
        if (result.status === "ok") onOpenSkill(result.value.skillId);
        else if (result.status === "conflict") controller.observeDisk(result.document);
        else toast.danger(result.message);
      },
      {
        onError: () => {
          toast.danger(`Couldn't rename ${skill.name}`);
        },
        cleanup: () => setRenaming(false),
      },
    );
  };

  if (!file.document.writable) {
    return <h1 className={PAGE_TITLE_TEXT_CLASS_NAME}>{skill.name}</h1>;
  }
  return (
    <input
      aria-label="Skill name"
      // A new skill opens ready to be named.
      autoFocus={autoFocus}
      spellCheck={false}
      disabled={renaming}
      className={cn(PAGE_TITLE_TEXT_CLASS_NAME, QUIET_FIELD_CLASS)}
      placeholder="skill-name"
      value={draft ?? skill.name}
      onFocus={(event) => {
        if (autoFocus) event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        if (!cancelBlur.current) void commit();
        cancelBlur.current = false;
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelBlur.current = true;
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** When an Agent should reach for the skill: the sentence it decides by, edited in place. */
function SkillDescription({
  file,
  controller,
}: {
  readonly file: SkillFileSnapshot;
  readonly controller: SkillFileController;
}) {
  const { frontmatter } = useSkillEditorSnapshot(file.session).source;
  const [draft, setDraft] = useState<string | null>(null);
  const cancelBlur = useRef(false);
  const value = frontmatter.description.value ?? "";
  const editable =
    file.document.writable && frontmatter.description.patchable && file.mode === "rich";

  const commit = async () => {
    const typed = draft?.replace(/\s*\n\s*/gu, " ").trim();
    if (typed === undefined || typed === value) {
      setDraft(null);
      return;
    }
    const result = await controller.patchFrontmatter({ description: typed });
    setDraft(null);
    if (!result.ok) toast.danger(result.reason);
  };

  if (!editable) {
    return value ? (
      <p className="text-base leading-relaxed whitespace-pre-wrap text-token-text-secondary">
        {value}
      </p>
    ) : null;
  }
  return (
    <textarea
      aria-label="When to use this skill"
      rows={1}
      className={cn(
        QUIET_FIELD_CLASS,
        "[field-sizing:content] text-base leading-relaxed text-token-text-secondary",
      )}
      placeholder="When should an Agent use this skill?"
      value={draft ?? value}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        if (!cancelBlur.current) void commit();
        cancelBlur.current = false;
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          cancelBlur.current = true;
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** The skill's other files, each opening beside the page like any file. */
function SkillFiles({
  context,
  skill,
  files,
}: {
  readonly context: SkillInventoryContext;
  readonly skill: SkillInventoryEntry;
  readonly files: readonly string[];
}) {
  const router = useFileReferenceRouter();
  const others = files.filter((file) => file !== "SKILL.md");
  if (others.length === 0) return null;
  const separator = skill.directory.includes("\\") ? "\\" : "/";
  return (
    <div className="flex flex-wrap gap-1.5 border-t-[0.5px] border-token-border pt-4 pb-8">
      {others.map((file) => (
        <button
          key={file}
          type="button"
          className="cursor-interaction rounded-md px-2 py-0.5 font-mono text-xs text-token-text-secondary ring-[0.5px] ring-token-border outline-hidden ring-inset hover:bg-token-foreground/5 focus-visible:bg-token-foreground/10"
          onClick={() =>
            void router.open(
              { path: `${skill.directory}${separator}${file.replaceAll("/", separator)}` },
              { hostId: context.hostId, title: file.split("/").at(-1) },
            )
          }
        >
          {file}
        </button>
      ))}
    </div>
  );
}

function LoadedSkillPage({
  context,
  skill,
  location,
  destinations,
  document,
  onOpenSkill,
  onClose,
  onTry,
  autoFocusName,
  surfaceKey,
  onMetadataChange,
}: Omit<SkillPageProps, "skillId" | "className"> & {
  readonly skill: SkillInventoryEntry;
  readonly location: SkillLocation;
  readonly destinations: readonly SkillLocation[];
  readonly document: SkillDocument;
}) {
  const { controller, file } = useSkillFile(context, document, surfaceKey);
  useEffect(() => onMetadataChange?.(skill), [onMetadataChange, skill]);
  const { source } = useSkillEditorSnapshot(file.session);
  const personal = destinations.find((candidate) => candidate.scope === "user");
  const commands = useSkillCommands(context);
  const readOnly = !file.document.writable;

  const duplicateToEdit = async () => {
    if (!personal) return;
    const result = await commands.transfer({
      skillId: skill.id,
      locationId: personal.id,
      slug: availableSkillSlug(personal, skillSlugFromInput(skill.name) ?? "skill"),
      mode: "copy",
    });
    if (result.status === "ok") onOpenSkill(result.value.skillId);
    else toast.danger(result.message);
  };

  return (
    <div className={cn(PAGE_COLUMN_CLASS, "flex min-h-full flex-col pt-10")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <SkillName
            skill={skill}
            file={file}
            controller={controller}
            context={context}
            location={location}
            autoFocus={autoFocusName === true}
            onOpenSkill={onOpenSkill}
          />
        </div>
        <div className="flex h-9 shrink-0 items-center gap-1">
          <SaveStatus file={file} />
          <SkillAgentMarks context={context} skill={skill} className="ms-2" />
          {readOnly && !source.rich.editable ? null : (
            <ToolbarButton
              color={file.mode === "source" ? "ghostActive" : "ghost"}
              aria-pressed={file.mode === "source"}
              disabled={!source.rich.editable && file.mode === "source"}
              onClick={() => void controller.setMode(file.mode === "source" ? "rich" : "source")}
            >
              Source
            </ToolbarButton>
          )}
          <SkillActionsMenu
            context={context}
            skill={skill}
            location={location}
            destinations={destinations}
            beforeTransfer={controller.flush}
            onTry={onTry ? () => onTry(skill) : undefined}
            onRelocated={(skillId, mode) => {
              if (mode === "move") onOpenSkill(skillId);
            }}
            onDeleted={onClose}
          />
        </div>
      </div>
      <div className="px-0.5 pt-1 text-sm text-token-description-foreground">
        {skillLocationKind(location)} ·{" "}
        <NodexTooltip tooltipContent={location.directory} side="bottom">
          <span>{displaySkillLocation(location)}</span>
        </NodexTooltip>
      </div>
      <div className="px-0.5 pt-3">
        <SkillDescription file={file} controller={controller} />
      </div>

      {file.conflict ? (
        <PageNotice
          actions={
            <>
              <ToolbarButton color="ghost" onClick={() => void controller.resolveConflict("disk")}>
                Use the file
              </ToolbarButton>
              <ToolbarButton
                color="outline"
                onClick={() => void controller.resolveConflict("mine")}
              >
                Keep my edits
              </ToolbarButton>
            </>
          }
        >
          This skill's file changed while you were editing it.
        </PageNotice>
      ) : readOnly ? (
        <PageNotice
          actions={
            personal ? (
              <ToolbarButton color="outline" onClick={() => void duplicateToEdit()}>
                Duplicate to edit
              </ToolbarButton>
            ) : null
          }
        >
          {location.scope === "plugin"
            ? "This skill belongs to a plugin, so it can't be changed here."
            : "This skill is built in, so it can't be changed here."}
        </PageNotice>
      ) : !source.rich.editable ? (
        <PageNotice>
          This skill is edited as source: {source.rich.reason.replace(/\.$/u, "")}.
        </PageNotice>
      ) : file.save.kind === "refused" ? (
        <PageNotice
          actions={
            <ToolbarButton color="outline" onClick={() => void controller.resolveConflict("disk")}>
              Discard edit
            </ToolbarButton>
          }
        >
          That edit would rewrite surrounding text. Discard it, then switch to Source to make it.
        </PageNotice>
      ) : null}

      <div className="pt-4 pb-8">
        {file.mode === "rich" ? (
          <SkillBodyEditor session={file.session} readOnly={readOnly || file.conflict !== null} />
        ) : (
          <WorkspacePierreEditor
            value={file.sourceText}
            filename="SKILL.md"
            language="markdown"
            readOnly={readOnly || file.conflict !== null}
            sourceIdentity={`skill:${skill.id}`}
            documentVersion={file.sourceVersion}
            ariaLabel={`Source of ${skill.name}`}
            className="h-[calc(100vh-18rem)] min-h-80 overflow-hidden rounded-lg ring-[0.5px] ring-token-border ring-inset"
            onChange={(text) => {
              if (!readOnly) controller.setSourceText(text);
            }}
          />
        )}
      </div>
      <SkillFiles context={context} skill={skill} files={file.document.files} />
    </div>
  );
}

/**
 * A skill shown the way a Page is: its name as the title, the sentence that tells an Agent when
 * to use it, and its instructions in the Page editor. The page is the SKILL.md on disk: edits
 * save back to it touching only what changed, and changes made elsewhere appear here.
 */
export function SkillPage({ className, skillId, context, ...props }: SkillPageProps) {
  const inventory = useSkillInventory(context);
  const document = useSkillDocument(context, skillId);
  const snapshot = inventory.data?.status === "ok" ? inventory.data.value : undefined;
  const found = findSkill(snapshot, skillId);

  let content: ReactNode;
  if (document.isPending || inventory.isPending) {
    content = (
      <PageMessage>
        <span role="status" className="nodex-loading-deferred text-token-description-foreground">
          <ActivitySpinnerIcon className="icon-xs" />
        </span>
      </PageMessage>
    );
  } else if (!found || document.data?.status !== "ok") {
    content = (
      <PageMessage>
        <PageEmptyState
          title="This skill is no longer here"
          description={
            document.data?.status === "failed"
              ? document.data.message
              : "It may have been moved, renamed or deleted."
          }
        />
      </PageMessage>
    );
  } else {
    content = (
      <LoadedSkillPage
        key={skillId}
        context={context}
        skill={found.skill}
        location={found.location}
        destinations={(snapshot?.locations ?? []).filter((location) => location.writable)}
        document={document.data.value}
        {...props}
      />
    );
  }
  return (
    <div
      data-skill-page={skillId}
      className={cn("scrollbar-token h-full w-full overflow-y-auto bg-(--background)", className)}
    >
      {content}
    </div>
  );
}
