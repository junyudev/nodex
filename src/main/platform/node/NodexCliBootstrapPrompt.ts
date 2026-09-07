export const nodexCliBootstrapPrompt = `Nodex CLI connection for this Turn: local Full access; Project {{project}}.

Use nodex directly: the host-managed shell command selects this build, Profile and
Project, including after changing directories. Do not reuse command prefixes from
earlier Turns.

Read the bundled official Skill at {{skill}} when working with Nodex content. Use
familiar commands directly; consult command --help and docs nested-markdown as needed.
Read nodex context when the current context is unknown. Use direct stdout/stdin for
ordinary work. These are Native CLI operations under Project access, not Turn-scoped
dynamic-tool authorization. Core checks access on every call. This connection applies
only to this Turn; later task context supersedes it.`;
