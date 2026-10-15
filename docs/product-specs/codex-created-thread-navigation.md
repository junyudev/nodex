# Created conversation targets

Runtime conversation targets carry an explicit product Session id and engine Thread id. Session summaries retain the immutable execution reference even when no native Thread is attached. Opening a root or descendant first reads the current Core Session, then performs one bounded metadata inspection of that exact Session and Thread. A cached draft cannot replace a newly admitted binding.

- Root navigation selects the bound product Session. Child and grandchild panels retain that same Session and their own engine Thread identity; they do not manufacture a native Core Thread.
- The captured inspection is reused within the same navigation request. A later navigation intent wins over delayed Core or engine replies, and failed or changed bindings do not select a different target.
- Controls inspect metadata before mounting the transcript owner. Navigation does not load conversation bodies. Subsequent commands independently validate current execution and native lifetime.
- An explicit target Session supplied by a card is preserved rather than overwritten by the conversation that rendered it.

Native conversation cards carry an explicit execution host and either a native Thread id or a pending client Thread id. Unsupported targets remain noninteractive. Opening a native root conversation validates its current Core binding, including a previously cached Session.

- An existing root Session on the requested host opens without a native request or Core mutation, including offline conversations created with a subagent source.
- Sidebar discovery, palette search and notification admission preserve that live root link. A subagent source label cannot hide the Session or discard its streaming replies. Real parents, ephemeral helpers, system sources and structured-title leases retain their own exclusion rules.
- A missing root is observed through a metadata-only native read. Core validates the captured host, project and Session binding, then creates and links one Session in a single transaction. A changed binding rejects the navigation without selecting another host or Session.
- A conversation with a real parent opens in its parent context. Selected-child hydration carries the source host through discovery and metadata reads. Metadata admission checks the captured host, project, Session and parent together; a change during a native read cannot overwrite the new binding.
- Pending targets use their actual launch host. A persisted native id does not make a launch ready while its pending owner is still active. Readonly resolution performs no discovery, connection startup or Session command; unknown and ambiguous coordinates remain unresolved.

Card summaries use one metadata-only read and at most one descending page of 100 native items. The latest nonempty assistant reply excludes synchronous commentary and uses compact Markdown text projection. Summary reads do not install conversation history, create a Session or write Core. Native completion and metadata notifications invalidate only their host-qualified targets; streaming text deltas do not trigger card queries.

The typed `codex:thread:ensure-open` command returns the validated root Session or no root target. The `codex:thread:child-summary` and `codex:created-thread:resolve` queries remain readonly.
