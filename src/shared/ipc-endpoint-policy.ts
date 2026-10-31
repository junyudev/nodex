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
  | "codex:plugins:marketplaces"
  | "codex:plugins:apps"
  | "codex:plugins:mcp-servers"
  | "codex:plugins:recommended-skills"
  | "codex:plugins:creation-capabilities"
  | "codex:plugins:plugin-hooks"
  | "codex:plugins:context"
  | "codex:plugins:capabilities"
  | "codex:plugins:list"
  | "codex:plugins:installed"
  | "codex:plugins:read"
  | "codex:plugins:search"
  | "codex:plugins:skills"
  | "codex:plugins:skill-contents"
  | "codex:plugins:app-tools"
  | "mcp-app:data:capabilities"
  | "codex:plugins:hooks"
  | "codex:plugins:public-home"
  | "codex:plugins:category"
  | "codex:plugins:personal"
  | "codex:plugins:personal-page"
  | "codex:plugins:marketplace-removal-preview"
  | "acp:registry:search"
  | "acp:inspect"
  | "acp:install:preview"
  | "acp:operation:read"
  | "acp:auth:read"
  | "acp:sessions:list"
  | "acp:sessions:prepareImport"
  | "acp:modelProviders:list"
  | "agent-runtime:activity:read"
  | "agent-runtime:connection:read"
  | "agent-runtime:session:read"
  | "agent-runtime:session:control"
  | "agent-runtime:session:inspect"
  | "agent-runtime:session:overview"
  | "agent-runtime:session:background-output"
  | "agent-runtime:session:history"
  | "agent-runtime:session:prompt-index"
  | "agent-runtime:session:attachment"
  | "agent-runtime:session:queue-read"
  | "agent-runtime:session:run-message"
  | "agent-runtime:session:queued-preview"
  | "agent-runtime:session:item"
  | "agent-runtime:providers:read"
  | "agent-runtime:providers:known"
  | "agent-runtime:claude-usage:read"
  | "agent-runtime:claude-usage:refresh"
  | "document-recovery:read"
  | "agent-backend:claude:models"
  | "agent-backend:claude:discover"
  | "agent-backend:model-catalog:read"
  | "agent-backend:session:inspect"
  | "agent-backend:session:history"
  | "agent-backend:session:history-image"
  | "agent-backend:session:tool-output"
  | "agent-import:scan"
  | "agent-import:scan-picked-home"
  | "native-sessions:list"
  | "native-sessions:preview-import"
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
  | "blocks:transfer:plan"
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
  | "codex:account:snapshot"
  | "codex:automation-runs:inbox-items"
  | "codex:composer-appshot:target"
  | "codex:composer-prediction:availability"
  | "codex:composer-chatgpt-conversations:list"
  | "codex:composer-sites:list"
  | "codex:composer-plugins:list"
  | "codex:composer-skills:list"
  | "codex:connection:status"
  | "codex:conversation-image-asset:resolve"
  | "codex:dictation:global-permissions:read"
  | "codex:dictation:history:list"
  | "codex:dictation:history:read-audio"
  | "codex:dictation:microphone-access:read"
  | "codex:dictation:microphone-route-hint:read"
  | "codex:dictation:settings:read"
  | "codex:dictation:voice-language:read"
  | "codex:dictation:dictionary:read"
  | "codex:dictation:state:read"
  | "codex:realtime-voice:read"
  | "codex:experimental-features:list"
  | "codex:hooks:list"
  | "codex:mcp-apps:list"
  | "codex:mcp-resource:read"
  | "codex:visualization:read"
  | "codex:visualization:state:read"
  | "codex:visualization:capture-image"
  | "codex:mcp-server-statuses:list"
  | "codex:pasted-text:read"
  | "codex:thread-handoffs:list"
  | "thread-execution:location"
  | "codex:pending-worktrees:list"
  | "codex:personality:get"
  | "codex:projectless-thread-cwd"
  | "codex:renderer-client:id"
  | "codex:scheduled-automations:list"
  | "codex:sidebar:snapshot"
  | "codex:subagents:overview:read"
  | "codex:thread:history-search"
  | "codex:thread:history-timeline"
  | "codex:thread:background-processes:list"
  | "codex:thread:background-terminals:list"
  | "codex:thread:goal:editable-objective:read"
  | "codex:thread:goal:get"
  | "codex:thread:summary:get"
  | "codex:thread:child-summary"
  | "codex:created-thread:resolve"
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
  | "global-dictation-capture-bare-modifier-hotkey"
  | "library-database-module:read"
  | "library-database:list-window:get"
  | "library-database:view-groups:get"
  | "library-database:view-window:get"
  | "library-module:read"
  | "library-pages:detail:get"
  | "page-chats:session-linked-pages"
  | "page-chats:activity-summaries"
  | "page-chats:list"
  | "inbox:summary"
  | "inbox:counts"
  | "inbox:window"
  | "inbox:prepare-confirmation"
  | "inbox:chat-targets"
  | "files:read"
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
  | "workspace-file:github-url"
  | "native-resource:read"
  | "read-file-metadata"
  | "settings:app-updates:get"
  | "settings:acp-agents:get"
  | "settings:acp-agents:configuration-status"
  | "settings:claude-agents:get"
  | "settings:opencode-agents:get"
  | "opencode-setup:read"
  | "nodex-account:read"
  | "settings:codex-home:get"
  | "settings:backup:get"
  | "settings:codex-developer:get"
  | "settings:diagnostics:get"
  | "settings:git:get"
  | "settings:history:get"
  | "settings:telemetry:get"
  | "settings:third-party-notices:get"
  | "settings:thread-notifications:get"
  | "settings:notification-authorization:read"
  | "settings:window-restore:get"
  | "settings:composer-predictions:get"
  | "settings:inbox:get"
  | "shell:file-link-openers:list-available"
  | "file-open-applications"
  | "shell:path-context:get"
  | "sidebar-sections:item:placement"
  | "sidebar-sections:items:list"
  | "sidebar-sections:list"
  | "sidebar:builtin-order:list"
  | "terminal-session:snapshot"
  | "thread-terminal-snapshot"
  | "window-sessions:bootstrap"
  | "workspace-directory-entries"
  | "workspace-paths-exist"
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
  | "agent-runtime:session:observe"
  | "agent-runtime:session:unobserve"
  | "codex:visualization:consume-gesture"
  | "codex:visualization:release"
  | "codex:visualization:set-presentation"
  | "editor-history:release"
  | "editor-history:abandon"
  | "editor-history:abandon-transfer"
  | "agent-backend:claude:cancel-discovery"
  | "agent-backend:model-catalog:cancel"
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
  | "surface-history:bind"
  | "surface-history:publish"
  | "clipboard:write-claimed-presentation"
  | "remote-hosted-pip:host-layout:report"
  | "codex:realtime-voice:prepare"
  | "codex:realtime-voice:report-media"
  | "codex:realtime-voice:set-muted"
  | "codex:realtime-voice:release"
  | "codex:dictation:microphone-lease:acquire"
  | "codex:dictation:microphone-lease:release"
  | "codex:dictation:transcribe:cancel"
  | "codex:dictation:dictionary:cancel"
  | "codex:dictation:history:append"
  | "codex:dictation:history:finalize"
  | "codex:dictation:history:set-diagnostics"
  | "codex:dynamic-tool-call:respond"
  | "codex:fork-side-panel-transfer:consume"
  | "codex:mcp-elicitation:respond"
  | "codex:option-picker:respond"
  | "codex:pending-worktree:discard-fork-side-panel-transfer"
  | "workbench-agent:register"
  | "codex:turn-presentation:capture"
  | "workbench-agent:release"
  | "workbench-agent:reply"
  | "codex:scheduled-automations:heartbeat-enabled-changed"
  | "codex:scheduled-automations:heartbeat-thread-state-changed"
  | "codex:setup-codex-step:respond"
  | "codex:setup-context-picker:respond"
  | "codex:sidebar:sync"
  | "codex:subagents:selected:hydrate"
  | "codex:app-server:request"
  | "codex:thread:history-hydration:prepare"
  | "codex:app-server:host-context"
  | "codex:composer-prediction:request"
  | "codex:composer-prediction:clear"
  | "codex:queued-messages:prepare-native"
  | "codex:queued-messages:read"
  | "codex:queued-messages:write"
  | "codex:queued-messages:prepare"
  | "codex:queued-messages:acquire-send"
  | "codex:queued-messages:release-send"
  | "codex:thread:native-fork:prepare"
  | "codex:thread:native-fork:execute"
  | "codex:thread:native-fork:accept"
  | "codex:thread:native-fork:release"
  | "codex:turn:native:inject"
  | "codex:turn:native-steer:prepare"
  | "codex:turn:native-steer:inspect"
  | "codex:turn:native-steer:execute"
  | "codex:turn:native-steer:release"
  | "codex:thread:interrupt-effects"
  | "codex:thread:node-repl:cleanup"
  | "codex:thread:settings:prepare-profile"
  | "codex:turn:native:prepare"
  | "codex:turn:native:execute"
  | "codex:turn:native:inspect"
  | "codex:turn:native:release"
  | "codex:app-server:respond"
  | "codex:app-server:request:abandon"
  | "codex:thread:goal:materialized-cleanup"
  | "codex:thread:resume:prepare"
  | "codex:thread:resume:retry"
  | "codex:thread:resume:accept"
  | "codex:thread:resume:release"
  | "codex:thread:history-export:cancel"
  | "codex:thread:history-export:next"
  | "codex:thread:history-export:start"
  | "codex:thread:snapshot:request"
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
  | "global-dictation-hotkey-capture:cancel"
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
  | "workspace-text-search:start"
  | "workspace-text-search:stop"
  | "file-search:start"
  | "file-search:update"
  | "file-search:stop"
  | "workspace-file-watch:start"
  | "workspace-file-watch:stop";

type CoreLocalCommitCommandEndpointPolicy =
  | "inbox:send"
  | "inbox:edit"
  | "inbox:confirm"
  | "inbox:dispatch"
  | "inbox:keep"
  | "inbox:delete"
  | "inbox:set-state"
  | "inbox:set-kind"
  | "inbox:set-important"
  | "inbox:request-suggestion"
  | "inbox:retry-dispatch"
  | "inbox:undo"
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
  | "project-sessions:record-opened"
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
  | "sidebar-sections:sessions:reorder"
  | "sidebar:builtin-order:reorder";

type MainRevisionCommandEndpointPolicy =
  | "persisted-atom:update"
  | "codex:visualization:state:write"
  | "codex:visualization:interaction:write";

type PlainResultCommandEndpointPolicy =
  | "mcp-app:data:clear"
  | "codex:plugins:app-disconnect"
  | "codex:plugins:app-enabled"
  | "codex:plugins:app-tool-enabled"
  | "codex:plugins:plugin-hooks-trust"
  | "codex:plugins:plugin-mcp-enabled"
  | "codex:plugins:mcp-save"
  | "codex:plugins:mcp-remove"
  | "codex:plugins:mcp-enabled"
  | "codex:plugins:mcp-login"
  | "codex:plugins:skill-install"
  | "codex:plugins:skill-uninstall"
  | "codex:plugins:prepare-helper"
  | "codex:plugins:install"
  | "codex:plugins:uninstall"
  | "codex:plugins:set-enabled"
  | "codex:plugins:skill-enabled"
  | "codex:plugins:marketplace-add"
  | "codex:plugins:marketplace-remove"
  | "codex:plugins:marketplace-upgrade"
  | "codex:plugins:refresh"
  | "acp:install:start"
  | "acp:registry:uninstall"
  | "acp:connection:start"
  | "acp:operation:cancel"
  | "acp:auth:start"
  | "acp:auth:respond"
  | "acp:auth:complete"
  | "acp:auth:cancel"
  | "acp:auth:logout"
  | "acp:urlAuth:accept"
  | "acp:sessions:delete"
  | "acp:sessions:import"
  | "acp:modelProviders:set"
  | "acp:modelProviders:disable"
  | "agent-runtime:session:launch"
  | "agent-runtime:session:message"
  | "agent-runtime:session:queue-message"
  | "agent-runtime:session:queue"
  | "agent-runtime:session:create-side-chat"
  | "agent-runtime:session:discard-side-chat"
  | "agent-runtime:session:save-side-chat"
  | "agent-runtime:session:fork"
  | "agent-runtime:session:merge-back"
  | "agent-runtime:session:stop"
  | "agent-runtime:session:respond"
  | "agent-runtime:session:set-modes"
  | "agent-runtime:session:compact"
  | "agent-runtime:session:clear-context"
  | "agent-runtime:session:rollback"
  | "agent-runtime:session:stop-task"
  | "agent-runtime:session:stop-background"
  | "agent-runtime:session:cancel-task"
  | "agent-runtime:session:retry-preparation"
  | "agent-runtime:session:move"
  | "agent-import:apply"
  | "native-sessions:import"
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
  | "agent-runtime:claude-usage:logout"
  | "codex:account:rate-limit-reset:consume"
  | "codex:visualization:open-external"
  | "codex:visualization:copy-image"
  | "codex:composer-appshot:capture"
  | "codex:composer-plugins:activate"
  | "codex:conversation-unread:set"
  | "codex:dictation:cleanup"
  | "codex:dictation:global-permissions:open-accessibility-settings"
  | "codex:dictation:global-permissions:open-input-monitoring-settings"
  | "codex:dictation:global-permissions:request-accessibility"
  | "codex:dictation:global-permissions:request-input-monitoring"
  | "codex:dictation:history:create"
  | "codex:dictation:history:import-file"
  | "codex:dictation:history:delete"
  | "codex:dictation:history:download"
  | "codex:dictation:history:set-transcript"
  | "codex:dictation:microphone-access:open-settings"
  | "codex:dictation:microphone-access:request"
  | "codex:realtime-voice:start"
  | "codex:realtime-voice:stop"
  | "codex:realtime-voice:append-text"
  | "codex:realtime-voice:append-speech"
  | "codex:realtime-voice:inject-context"
  | "codex:dictation:settings:consume-global-shortcut-nudge"
  | "codex:dictation:settings:update"
  | "codex:dictation:voice-language:update"
  | "codex:dictation:dictionary:add"
  | "codex:dictation:dictionary:remove"
  | "codex:dictation:dictionary:import"
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
  | "thread-execution:handoff"
  | "codex:pending-worktree:dismiss"
  | "codex:pending-worktree:rename"
  | "codex:pending-worktree:resolve-thread"
  | "codex:pending-worktree:retry"
  | "codex:pending-worktree:set-pinned"
  | "codex:pending-worktree:set-pinned-before-thread"
  | "codex:pending-worktree:work-locally"
  | "codex:personality:set"
  | "codex:review:start"
  | "codex:scheduled-automations:create"
  | "codex:scheduled-automations:delete"
  | "codex:scheduled-automations:run-now"
  | "codex:scheduled-automations:update"
  | "codex:sidebar:thread:move"
  | "codex:thread:archive"
  | "codex:thread:background-processes:run-action"
  | "codex:thread:background-terminals:clean"
  | "codex:thread:background-terminals:clean-silent"
  | "codex:thread:background-terminals:terminate"
  | "codex:thread:collaboration-mode:set"
  | "codex:thread:compact:start"
  | "codex:thread:delete-archived"
  | "codex:thread:ensure-session"
  | "codex:thread:ensure-open"
  | "codex:thread:goal:clear"
  | "codex:thread:goal:materialize-draft"
  | "codex:thread:goal:set"
  | "codex:thread:memory-mode:set"
  | "codex:thread:name:set"
  | "codex:thread:name:set-generated"
  | "codex:thread:presentation:set"
  | "codex:thread:settings:update"
  | "codex:thread:side-chat:discard"
  | "codex:thread:side-chat:start"
  | "codex:thread:title:generate"
  | "codex:thread:unarchive"
  | "codex:threads:pinned:reorder"
  | "codex:threads:pinned:set"
  | "codex:turn:interrupt"
  | "codex:turn:start"
  | "codex:turn:steer"
  | "codex:turn:question-reply"
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
  | "workspace:page:create-for"
  | "page-chats:link"
  | "page-chats:unlink"
  | "files:pick-and-prepare"
  | "files:prepare"
  | "files:prepare-local-drop"
  | "files:materialize"
  | "files:save"
  | "document-recovery:export"
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
  | "settings:claude-agents:update"
  | "settings:opencode-agents:update"
  | "opencode-setup:install"
  | "opencode-setup:cancel"
  | "nodex-account:sign-in"
  | "nodex-account:cancel-sign-in"
  | "nodex-account:sign-out"
  | "nodex-account:refresh"
  | "settings:codex-home:update"
  | "settings:backup:update"
  | "settings:codex-developer:update"
  | "settings:diagnostics:update"
  | "settings:git:update"
  | "settings:history:update"
  | "settings:telemetry:update"
  | "settings:thread-notifications:update"
  | "settings:notification-authorization:request"
  | "settings:notification-authorization:open-settings"
  | "settings:window-restore:update"
  | "settings:composer-predictions:update"
  | "settings:inbox:update"
  | "shell:open-external-url"
  | "shell:open-file-link"
  | "shell:open-file-with-application"
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
  | "write-file"
  | "workspace-file:save-copy"
  | "workspace-file:save-data"
  | "browser-link:save";

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

// Keep selection on the channel policy itself. Reconstructing it from IpcEndpointPolicy
// repeatedly relates every endpoint's argument/result graph for generic callers.
export type IpcQueryChannel = QueryEndpointPolicy;
export type IpcControlChannel = ControlEndpointPolicy;
export type IpcCommandChannel =
  | CoreLocalCommitCommandEndpointPolicy
  | MainRevisionCommandEndpointPolicy
  | PlainResultCommandEndpointPolicy;

interface CommandChannelsByAcknowledgement {
  readonly core_local_commit: CoreLocalCommitCommandEndpointPolicy;
  readonly main_revision: MainRevisionCommandEndpointPolicy;
  readonly plain_result: PlainResultCommandEndpointPolicy;
}

export type IpcCommandChannelFor<Acknowledgement extends IpcAcknowledgement> =
  CommandChannelsByAcknowledgement[Acknowledgement];

export type CoreLocalCommitCommandChannel = IpcCommandChannelFor<"core_local_commit">;
export type MainRevisionCommandChannel = IpcCommandChannelFor<"main_revision">;
export type PlainResultCommandChannel = IpcCommandChannelFor<"plain_result">;

export type IpcOperationDefinitionMap<OperationKind extends PropertyKey, Definition> = Readonly<
  Record<OperationKind, Definition>
>;
