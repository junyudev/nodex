# ADR 0061: CLI-first Agent content interface

Status: Accepted
Date: 2026-09-06
Supersedes: ADR 0016's default dynamic-tool entrypoint and CLI read-validator omission

## Context

Agents need to read content, combine ordinary shell tools, and commit precise
changes without exporting every intermediate result or learning duplicate
content interfaces. The native CLI already connects to the same Core semantics
as the desktop. Its remaining gaps are discovery, structured values, and
consistent executable help.

## Decision

Use the CLI and bundled Skill as the default local content Interface. Preserve
Nested Markdown for bodies, typed values and queries for Database operations,
and explicit ownership commands. Provide direct stdin/stdout composition and
bounded machine-readable help. Regular files and drafts remain optional tools
for processing, review, and recovery. Share creation/query implementations inside
Core while preserving the caller's actual authorization path.

Keep dynamic content tools behind the default-off development feature. Gate
registration and execution; a persisted catalog is not authorization to bypass
the current instance setting. Preserve historical result rendering.

Provide host connection context for each eligible local Full access Turn. Pin
the executable, Skill, Profile, and Project; refresh on each Turn. Native CLI
uses Project access and is not advertised as Turn-scoped authorization. Restricted
and remote modes remain outside automatic connection until a trusted channel
can enforce their intended constraints.

Structured Page reads include title/body validators from the same observation,
so a subsequent local edit can reuse its existing read. Operation-dependent
ownership/View conditions remain explicit. Validation checks are never silently
refreshed at write time merely to avoid conflicts.

## Consequences

Agents can discover, read, patch, query, and write through the same interface
used by people and scripts. Temporary queries do not imitate saved Views;
Page attachment changes do not imitate shared File writes. The command catalog
can grow where a distinct domain contract earns an operation without adding
workflow-specific research or report tools.

ADR 0016's semantic operations, bounded output, stable identity, and progressive
format disclosure principles remain valid. Its dynamic catalog is retained as
an experimental Adapter rather than the default development target. A general
filesystem mount, SQL interface, or internal execution language is unnecessary
for this decision.
