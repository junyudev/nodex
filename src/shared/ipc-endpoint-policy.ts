import type { IpcApi } from "./ipc-api";
import type { LocalCommitApply, LocalCommitCommandSuccess } from "./local-commit-delivery";

export type IpcAcknowledgement = "core_local_commit" | "main_revision" | "plain_result";

export interface RevisionedCommandSuccess<Value> {
  readonly ok: true;
  readonly value: Value;
  readonly revision: number;
}

export type IpcAcknowledgedCommandResult<
  Acknowledgement extends IpcAcknowledgement,
  Value,
  Failure = never,
> = Acknowledgement extends "core_local_commit"
  ? LocalCommitCommandSuccess<Value> | Failure
  : Acknowledgement extends "main_revision"
    ? RevisionedCommandSuccess<Value> | Failure
    : Value | Failure;

export interface IpcQuery<Args extends readonly unknown[], Result> {
  readonly kind: "query";
  readonly args: Args;
  readonly result: Result;
}

export interface IpcControl<Args extends readonly unknown[], Result> {
  readonly kind: "control";
  readonly args: Args;
  readonly result: Result;
}

type SuccessfulResult<Result> = Extract<Result, { readonly ok: true }>;
type AcknowledgedResult<Result> = [SuccessfulResult<Result>] extends [never]
  ? Result
  : SuccessfulResult<Result>;

export type IpcResultSatisfiesAcknowledgement<
  Acknowledgement extends IpcAcknowledgement,
  Result,
> = Acknowledgement extends "plain_result"
  ? true
  : Acknowledgement extends "core_local_commit"
    ? [SuccessfulResult<Result>] extends [never]
      ? false
      : SuccessfulResult<Result> extends {
            readonly value: unknown;
            readonly localCommit: LocalCommitApply;
          }
        ? true
        : false
    : AcknowledgedResult<Result> extends {
          readonly value: unknown;
          readonly revision: number;
        }
      ? true
      : false;

export type IpcCommand<
  Args extends readonly unknown[],
  Acknowledgement extends IpcAcknowledgement,
  Result,
> =
  IpcResultSatisfiesAcknowledgement<Acknowledgement, Result> extends true
    ? {
        readonly kind: "command";
        readonly acknowledgement: Acknowledgement;
        readonly args: Args;
        readonly result: Result;
      }
    : never;

/** Exact owner-audited groups. Never replace one group with an `Exclude<keyof IpcApi, ...>` remainder. */
type QueryEndpointPolicy =
  | "document-recovery:read"
  | "agent-backend:acp:session:read"
  | "agent-import:scan"
  | "agent-import:scan-picked-home"
  | "app:await-initialization"
  | "app:get-core-authority-status"
  | "app:runtime-capabilities:get"
  | "app:update:status"
  | "asset:image:read"
  | "asset:preview:read"
  | "asset:resolve-path"
  | "backup:capacity:get"
  | "backup:job:get"
  | "backup:list"
  | "backup:storage-optimization:get"
  | "block-document:owned:get"
  | "block-documents:history:get"
  | "block-documents:history:list"
  | "browser-annotation-capture-evidence"
  | "browser-contact-info-list"
  | "browser-credentials-list"
  | "browser-credentials-list-all"
  | "browser-downloads-list"
  | "browser-extensions-list"
  | "browser-history-list"
  | "browser-local-server-preferences-get"
  | "browser-local-server-thumbnail"
  | "browser-profile-capabilities"
  | "browser-profile-import-profiles"
  | "browser-sidebar-runtime-snapshot"
  | "browser-site-info"
  | "browser-use-policy-get"
  | "remote-hosted-pip:snapshot"
  | "calendar:occurrences"
  | "canvas-scene:compaction:read"
  | "clipboard:read-paste"
  | "codex-command-keymap-state"
  | "codex:account:read"
  | "codex:automation-runs:inbox-items"
  | "codex:collaboration-mode:list"
  | "codex:composer-appshot:target"
  | "codex:composer-chatgpt-conversations:list"
  | "codex:composer-plugins:list"
  | "codex:composer-sites:list"
  | "codex:composer-skills:list"
  | "codex:connection:status"
  | "codex:conversation-image-asset:resolve"
  | "codex:dictation:global-permissions:read"
  | "codex:dictation:history:list"
  | "codex:dictation:history:read-audio"
  | "codex:dictation:microphone-access:read"
  | "codex:dictation:microphone-route-hint:read"
  | "codex:dictation:settings:read"
  | "codex:dictation:state:read"
  | "codex:experimental-features:list"
  | "codex:hooks:list"
  | "codex:mcp-apps:list"
  | "codex:mcp-resource:read"
  | "codex:mcp-server-statuses:list"
  | "codex:model:list"
  | "codex:pasted-text:read"
  | "codex:pending-worktrees:list"
  | "codex:permission:mode:get"
  | "codex:permission:state:get"
  | "codex:personality:get"
  | "codex:projectless-thread-cwd"
  | "codex:renderer-client:id"
  | "codex:scheduled-automations:list"
  | "codex:sidebar:snapshot"
  | "codex:subagents:overview:read"
  | "codex:thread:history-search"
  | "codex:thread:background-processes:list"
  | "codex:thread:background-terminals:list"
  | "codex:thread:goal:editable-objective:read"
  | "codex:thread:goal:get"
  | "codex:thread:summary:get"
  | "codex:threads:list"
  | "codex:threads:palette:list"
  | "codex:threads:palette:search"
  | "codex:threads:pinned:list"
  | "codex:user-input:auto-resolution:snapshot"
  | "computer-use-settings-get"
  | "chrome-control-settings-get"
  | "database-module:read"
  | "database-row:get"
  | "database-view:reference:get"
  | "database:list-window:get"
  | "database:view-groups:get"
  | "database:view-window:get"
  | "electron-window:focus:get"
  | "gh-cli-status"
  | "gh-pr-checks"
  | "gh-pr-comments"
  | "gh-pr-diff"
  | "gh-pr-status"
  | "git:repository:identity"
  | "global-dictation-capture-fn-hotkey"
  | "library-database-module:read"
  | "library-database:list-window:get"
  | "library-database:view-groups:get"
  | "library-database:view-window:get"
  | "library-module:read"
  | "library-pages:detail:get"
  | "page-chats:activity-summaries"
  | "page-chats:list"
  | "page-files:read"
  | "page-ownership-path:resolve"
  | "page-target:resolve"
  | "pages:detail:get"
  | "pages:history:list"
  | "pages:lifecycle:preflight"
  | "pages:search"
  | "pages:search-facets"
  | "pages:search-metadata"
  | "persisted-atom:sync-request"
  | "project-sessions:get"
  | "projects:activity-summaries"
  | "projects:get"
  | "projects:list"
  | "read-file"
  | "read-file-binary"
  | "read-file-metadata"
  | "settings:app-updates:get"
  | "settings:acp-agents:get"
  | "settings:backup:get"
  | "settings:codex-developer:get"
  | "settings:diagnostics:get"
  | "settings:git:get"
  | "settings:history:get"
  | "settings:telemetry:get"
  | "settings:third-party-notices:get"
  | "settings:thread-notifications:get"
  | "settings:window-restore:get"
  | "shell:file-link-openers:list-available"
  | "shell:path-context:get"
  | "sidebar-sections:item:placement"
  | "sidebar-sections:items:list"
  | "sidebar-sections:list"
  | "terminal-session:snapshot"
  | "thread-terminal-snapshot"
  | "window-sessions:bootstrap"
  | "workspace-directory-entries"
  | "workspace-file-search"
  | "workspace:tasks:list"
  | "worktrees:environments:config:read"
  | "worktrees:environments:configs:list"
  | "worktrees:environments:configs:list-for-workspace"
  | "worktrees:environments:list"
  | "worktrees:execution-hosts:get"
  | "worktrees:list"
  | "worktrees:settings:get"
  | "worktrees:thread:availability";

type ControlEndpointPolicy =
  | "agent-backend:acp:session:observe"
  | "agent-backend:acp:session:unobserve"
  | "app:flush-before-close:done"
  | "avatar-overlay:event"
  | "browser-sidebar-webview-destroyed"
  | "browser-sidebar-webview-host-created"
  | "canvas-scene:presence:publish"
  | "canvas-scene:subscribe"
  | "canvas-scene:sync"
  | "canvas-scene:unsubscribe"
  | "clipboard:structural-await"
  | "clipboard:structural-begin"
  | "clipboard:structural-publish"
  | "clipboard:structural-settle"
  | "clipboard:write-claimed-presentation"
  | "remote-hosted-pip:host-layout:report"
  | "codex:approval:respond"
  | "codex:dictation:microphone-lease:acquire"
  | "codex:dictation:microphone-lease:release"
  | "codex:dictation:transcribe:cancel"
  | "codex:dictation:history:append"
  | "codex:dictation:history:finalize"
  | "codex:dynamic-tool-call:respond"
  | "codex:fork-side-panel-transfer:consume"
  | "codex:mcp-elicitation:respond"
  | "codex:option-picker:respond"
  | "codex:pending-worktree:discard-fork-side-panel-transfer"
  | "codex:permission-request:respond"
  | "codex:renderer-client:response"
  | "codex:scheduled-automations:heartbeat-enabled-changed"
  | "codex:scheduled-automations:heartbeat-thread-state-changed"
  | "codex:setup-codex-step:respond"
  | "codex:setup-context-picker:respond"
  | "codex:sidebar:sync"
  | "codex:subagents:selected:hydrate"
  | "codex:thread-follower:snapshot-applied"
  | "codex:thread-owner:notification:ack"
  | "codex:thread-owner:app-server-request"
  | "codex:thread-owner:pending-requests:replay"
  | "codex:thread-owner:stream-state:publish"
  | "codex:thread:fresh-owner:adopt"
  | "codex:thread:goal:materialized-cleanup"
  | "codex:thread:resume-buffer:release"
  | "codex:thread:resume:request"
  | "codex:thread:history-export:cancel"
  | "codex:thread:history-export:next"
  | "codex:thread:history-export:start"
  | "codex:thread:history-page:load"
  | "codex:thread:history-residency-pins:set"
  | "codex:thread:history-search:hydrate"
  | "codex:thread:prompt-rail:cancel"
  | "codex:thread:prompt-rail:index"
  | "codex:thread:prompt-rail:reveal"
  | "codex:thread:snapshot:request"
  | "codex:thread:stream-following:set"
  | "codex:thread:stream-resync:request"
  | "codex:thread:view-active:set"
  | "codex:user-input:auto-resolution:activity"
  | "codex:user-input:respond"
  | "diagnostics:renderer-log"
  | "document-sync:awareness:publish"
  | "document-sync:subscribe"
  | "document-sync:sync"
  | "document-sync:unsubscribe"
  | "git:action:cancel"
  | "git-worker:message-from-view"
  | "global-dictation:event"
  | "global-dictation:keyboard-layout:update"
  | "library-document-sync:awareness:publish"
  | "library-document-sync:subscribe"
  | "library-document-sync:sync"
  | "library-document-sync:unsubscribe"
  | "local-commit-audience:subscribe"
  | "local-commit-audience:unsubscribe"
  | "pages:search:cancel"
  | "recipient-delivery:admit"
  | "terminal-acquire-view"
  | "terminal-release-view"
  | "terminal-resize"
  | "terminal-take-over-view"
  | "terminal-write"
  | "workspace-file-watch:start"
  | "workspace-file-watch:stop";

type CoreLocalCommitCommandEndpointPolicy =
  | "document-recovery:apply"
  | "block-documents:command"
  | "block-documents:history:restore"
  | "block-documents:mutate"
  | "block-properties:mutate"
  | "blocks:transfer"
  | "blocks:transfer:undo"
  | "canvas-scene:apply"
  | "canvas-scene:compaction:apply"
  | "database-module:apply"
  | "document-sync:apply"
  | "library-block-properties:mutate"
  | "library-database-module:apply"
  | "library-document-sync:apply"
  | "library-module:apply"
  | "pages:lifecycle:apply"
  | "project-sessions:archive"
  | "project-sessions:create"
  | "project-sessions:delete"
  | "project-sessions:ensure-default-draft"
  | "project-sessions:mark-unread"
  | "project-sessions:rename"
  | "project-sessions:reorder"
  | "project-sessions:set-pinned"
  | "project-sessions:set-pinned-order"
  | "project-sessions:unarchive"
  | "project-sessions:update"
  | "projects:create"
  | "projects:reorder"
  | "projects:set-lifecycle"
  | "projects:set-pinned"
  | "projects:set-pinned-order"
  | "projects:update"
  | "sidebar-sections:create"
  | "sidebar-sections:delete"
  | "sidebar-sections:item:move"
  | "sidebar-sections:rename"
  | "sidebar-sections:reorder"
  | "sidebar-sections:restore"
  | "sidebar-sections:sessions:archive-all"
  | "sidebar-sections:sessions:create"
  | "sidebar-sections:sessions:reorder";

type MainRevisionCommandEndpointPolicy = "persisted-atom:update";

type PlainResultCommandEndpointPolicy =
  | "agent-backend:acp:session:authenticate"
  | "agent-backend:acp:session:cancel"
  | "agent-backend:acp:session:close"
  | "agent-backend:acp:session:open"
  | "agent-backend:acp:session:prompt"
  | "agent-backend:acp:session:set-config-option"
  | "agent-backend:acp:session:set-mode"
  | "agent-backend:acp:thread:start"
  | "agent-import:apply"
  | "app:update:check"
  | "app:update:install"
  | "avatar-overlay:toggle"
  | "remote-hosted-pip:task-visibility:set"
  | "app:relaunch-for-core-authority"
  | "app:restart"
  | "app:retry-core-authority"
  | "asset:canvas-image:materialize"
  | "asset:image:save"
  | "asset:resource:materialize"
  | "asset:resource:save"
  | "backup:cancel"
  | "backup:create"
  | "backup:delete"
  | "backup:restore"
  | "block-document:owned:prepare"
  | "block-documents:history:checkpoint"
  | "browser-browsing-data-clear"
  | "browser-contact-info-fill"
  | "browser-contact-info-remove"
  | "browser-contact-info-upsert"
  | "browser-credential-candidate-action"
  | "browser-credential-fill"
  | "browser-credential-generate-fill"
  | "browser-credential-remove"
  | "browser-download-action"
  | "browser-download-history-clear"
  | "browser-extension-load"
  | "browser-extension-remove"
  | "browser-history-delete"
  | "browser-local-server-preferences-update"
  | "browser-profile-import"
  | "browser-sidebar-command"
  | "browser-use-policy-update-modes"
  | "browser-use-policy-update-origin-rule"
  | "clipboard:write-image"
  | "codex:automation-runs:archive"
  | "codex:automation-runs:delete"
  | "codex:automation-runs:mark-all-read"
  | "codex:automation-runs:set-read-state"
  | "codex:automation-runs:unarchive"
  | "codex:account:login:cancel"
  | "codex:account:login:start"
  | "codex:account:logout"
  | "codex:account:rate-limit-reset:consume"
  | "codex:composer-appshot:capture"
  | "codex:composer-plugins:activate"
  | "codex:conversation-unread:set"
  | "codex:dictation:cleanup"
  | "codex:dictation:global-permissions:open-accessibility-settings"
  | "codex:dictation:global-permissions:open-input-monitoring-settings"
  | "codex:dictation:global-permissions:request-accessibility"
  | "codex:dictation:global-permissions:request-input-monitoring"
  | "codex:dictation:history:create"
  | "codex:dictation:history:delete"
  | "codex:dictation:history:download"
  | "codex:dictation:history:set-transcript"
  | "codex:dictation:microphone-access:open-settings"
  | "codex:dictation:microphone-access:request"
  | "codex:dictation:settings:consume-global-shortcut-nudge"
  | "codex:dictation:settings:update"
  | "codex:dictation:transcribe"
  | "codex:feedback:upload"
  | "codex:hooks:state:update"
  | "codex:mcp-tool:call"
  | "codex:pasted-text:create"
  | "codex:pasted-text:remove"
  | "codex:pending-worktree:auto-fix"
  | "codex:pending-worktree:cancel"
  | "codex:pending-worktree:clear-attention"
  | "codex:pending-worktree:continue"
  | "codex:pending-worktree:create"
  | "codex:pending-worktree:dismiss"
  | "codex:pending-worktree:rename"
  | "codex:pending-worktree:resolve-thread"
  | "codex:pending-worktree:retry"
  | "codex:pending-worktree:set-pinned"
  | "codex:pending-worktree:set-pinned-before-thread"
  | "codex:pending-worktree:work-locally"
  | "codex:permission:config-value:set"
  | "codex:permission:mode:set"
  | "codex:personality:set"
  | "codex:review:start"
  | "codex:scheduled-automations:create"
  | "codex:scheduled-automations:delete"
  | "codex:scheduled-automations:run-now"
  | "codex:scheduled-automations:update"
  | "codex:sidebar:thread:move"
  | "codex:thread-follower:action"
  | "codex:thread:archive"
  | "codex:thread:background-processes:run-action"
  | "codex:thread:background-terminals:clean"
  | "codex:thread:background-terminals:clean-silent"
  | "codex:thread:background-terminals:terminate"
  | "codex:thread:collaboration-mode:set"
  | "codex:thread:compact:start"
  | "codex:thread:delete-archived"
  | "codex:thread:ensure-session"
  | "codex:thread:follow-up:enqueue"
  | "codex:thread:follow-up:remove"
  | "codex:thread:follow-up:reorder"
  | "codex:thread:follow-up:replace"
  | "codex:thread:follow-up:resolve-after-fresh-start"
  | "codex:thread:follow-up:resume"
  | "codex:thread:follow-up:send-now"
  | "codex:thread:goal:clear"
  | "codex:thread:goal:materialize-draft"
  | "codex:thread:goal:set"
  | "codex:thread:memory-mode:set"
  | "codex:thread:name:set"
  | "codex:thread:name:set-generated"
  | "codex:thread:plan-implementation:remove"
  | "codex:thread:presentation:set"
  | "codex:thread:settings:update"
  | "codex:thread:side-chat:discard"
  | "codex:thread:side-chat:start"
  | "codex:thread:start-for-session"
  | "codex:thread:title:generate"
  | "codex:thread:unarchive"
  | "codex:threads:pinned:reorder"
  | "codex:threads:pinned:set"
  | "codex:turn:interrupt"
  | "codex:turn:start"
  | "codex:turn:steer"
  | "codex:user-input:auto-resolution:snooze"
  | "composer:pick-files"
  | "computer-use-settings-remove-app-approval"
  | "computer-use-settings-remove-message-approval"
  | "computer-use-settings-set-always-hide-pip"
  | "computer-use-settings-set-locked-use"
  | "computer-use-settings-set-sound-mode"
  | "gh-pr-comment"
  | "gh-pr-create"
  | "gh-pr-merge"
  | "gh-pr-update"
  | "git:action:commit"
  | "git:action:commit-message:generate"
  | "git:action:pull-request-message:generate"
  | "git:action:push"
  | "global-dictation:context-menu"
  | "library-block-document:owned:prepare"
  | "mcp-app:open-external"
  | "native-context-menu:show"
  | "open-file"
  | "page-chats:link"
  | "page-chats:unlink"
  | "page-files:pick-and-prepare"
  | "page-files:prepare"
  | "page-files:prepare-local-drop"
  | "page-files:save"
  | "page:occurrence:complete"
  | "page:occurrence:skip"
  | "page:occurrence:update"
  | "project-session-threads:attach"
  | "project-session-threads:detach"
  | "projects:pick-source-roots"
  | "project-sessions:fork"
  | "reset-codex-command-keybindings"
  | "set-codex-command-keybinding"
  | "settings:app-updates:update"
  | "settings:acp-agents:update"
  | "settings:backup:update"
  | "settings:codex-developer:update"
  | "settings:diagnostics:update"
  | "settings:git:update"
  | "settings:history:update"
  | "settings:telemetry:update"
  | "settings:thread-notifications:update"
  | "settings:window-restore:update"
  | "shell:open-external-url"
  | "shell:open-file-link"
  | "shell:open-path-default"
  | "terminal-create"
  | "terminal-kill"
  | "terminal-run-action"
  | "window:new"
  | "window:show-emoji-panel"
  | "window-sessions:save-layout"
  | "window-sessions:update-bounds"
  | "workspace:pick-directory"
  | "worktrees:delete"
  | "worktrees:environments:config:save"
  | "worktrees:execution-hosts:update"
  | "worktrees:settings:update"
  | "worktrees:thread:restore"
  | "write-file";

type ClassifiedEndpoint =
  | QueryEndpointPolicy
  | ControlEndpointPolicy
  | CoreLocalCommitCommandEndpointPolicy
  | MainRevisionCommandEndpointPolicy
  | PlainResultCommandEndpointPolicy;

type DuplicateEndpoint =
  | Extract<
      QueryEndpointPolicy,
      | ControlEndpointPolicy
      | CoreLocalCommitCommandEndpointPolicy
      | MainRevisionCommandEndpointPolicy
      | PlainResultCommandEndpointPolicy
    >
  | Extract<
      ControlEndpointPolicy,
      | CoreLocalCommitCommandEndpointPolicy
      | MainRevisionCommandEndpointPolicy
      | PlainResultCommandEndpointPolicy
    >
  | Extract<
      CoreLocalCommitCommandEndpointPolicy,
      MainRevisionCommandEndpointPolicy | PlainResultCommandEndpointPolicy
    >
  | Extract<MainRevisionCommandEndpointPolicy, PlainResultCommandEndpointPolicy>;

type TypeEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

type AssertTrue<Value extends true> = Value;
type AssertNever<Value extends never> = Value;

export type IpcEndpointPolicyIsComplete<
  Api extends object,
  Classified extends keyof Api,
> = TypeEqual<Classified, keyof Api>;

export type IpcEndpointPolicyCoverage = AssertTrue<
  IpcEndpointPolicyIsComplete<IpcApi, ClassifiedEndpoint>
>;
export type IpcEndpointPolicyDisjointness = AssertTrue<TypeEqual<DuplicateEndpoint, never>>;

type EvidenceCommandEndpoint =
  | CoreLocalCommitCommandEndpointPolicy
  | MainRevisionCommandEndpointPolicy;

type AcknowledgementFor<Channel extends EvidenceCommandEndpoint> =
  Channel extends CoreLocalCommitCommandEndpointPolicy ? "core_local_commit" : "main_revision";

type IncompatibleEvidenceEndpoint = {
  [Channel in EvidenceCommandEndpoint]: IpcResultSatisfiesAcknowledgement<
    AcknowledgementFor<Channel>,
    IpcApi[Channel]["result"]
  > extends true
    ? never
    : Channel;
}[EvidenceCommandEndpoint];

export type IpcAcknowledgementCoverage = AssertNever<IncompatibleEvidenceEndpoint>;

type EndpointPolicy<Channel extends keyof IpcApi> = Channel extends QueryEndpointPolicy
  ? IpcQuery<IpcApi[Channel]["args"], IpcApi[Channel]["result"]>
  : Channel extends ControlEndpointPolicy
    ? IpcControl<IpcApi[Channel]["args"], IpcApi[Channel]["result"]>
    : Channel extends CoreLocalCommitCommandEndpointPolicy
      ? IpcCommand<IpcApi[Channel]["args"], "core_local_commit", IpcApi[Channel]["result"]>
      : Channel extends MainRevisionCommandEndpointPolicy
        ? IpcCommand<IpcApi[Channel]["args"], "main_revision", IpcApi[Channel]["result"]>
        : Channel extends PlainResultCommandEndpointPolicy
          ? IpcCommand<IpcApi[Channel]["args"], "plain_result", IpcApi[Channel]["result"]>
          : never;

/** Erased endpoint metadata: runtime adapters select a typed method and never read this policy. */
export type IpcEndpointPolicy = {
  readonly [Channel in keyof IpcApi]: EndpointPolicy<Channel>;
};

type ChannelForKind<Kind extends IpcEndpointPolicy[keyof IpcApi]["kind"]> = {
  [Channel in keyof IpcEndpointPolicy]: IpcEndpointPolicy[Channel] extends { readonly kind: Kind }
    ? Channel
    : never;
}[keyof IpcEndpointPolicy];

export type IpcQueryChannel = ChannelForKind<"query">;
export type IpcControlChannel = ChannelForKind<"control">;
export type IpcCommandChannel = ChannelForKind<"command">;

export type IpcCommandChannelFor<Acknowledgement extends IpcAcknowledgement> = {
  [Channel in IpcCommandChannel]: IpcEndpointPolicy[Channel] extends {
    readonly acknowledgement: Acknowledgement;
  }
    ? Channel
    : never;
}[IpcCommandChannel];

export type CoreLocalCommitCommandChannel = IpcCommandChannelFor<"core_local_commit">;
export type MainRevisionCommandChannel = IpcCommandChannelFor<"main_revision">;
export type PlainResultCommandChannel = IpcCommandChannelFor<"plain_result">;

export type IpcOperationDefinitionMap<OperationKind extends PropertyKey, Definition> = Readonly<
  Record<OperationKind, Definition>
>;
