# Documentation Index

## Structure

| File | What it covers | When to read |
| --- | --- | --- |
| `configuration.md` | MCP server settings, vault location, lifecycle defaults, Obsidian scaffold, embeddings, and HTTP server options. | When changing install-time or runtime configuration. |
| `setup-guide.md` | Installation for supported clients, prerequisites, manual setup, and first-run verification. | When installing or onboarding a new client. |
| `architecture.md` | System overview, storage model, MCP flow, Obsidian role, and major subsystems. | When you need the big-picture design. |
| `performance.md` | Tool latency, memory footprint, cold/hot start, resilience model, embedding benchmarks. | When optimizing or debugging performance, or understanding failure recovery. |
| `tools-reference.md` | MCP tool catalog, inputs, outputs, and common usage patterns. | When wiring agents to the API. |
| `development.md` | Local development setup, repository workflow, testing, and release notes for contributors. | When working from source or contributing. |
| `note-lifecycle.md` | Atomic note model, lifecycle states, review flow, and promotion/archival behavior. | When changing note semantics or storage policy. |
| `obsidian.md` | Vault browsing, managed scaffold, navigation, plugins, and UI conventions. | When using or customizing the Obsidian vault. |

## Conventions

- `setup-guide.md` is the user-facing entry point for installation.
- `configuration.md` is the canonical reference for settings and defaults.
- `tools-reference.md` documents the MCP surface area.
- `architecture.md` explains how the parts fit together.
- `note-lifecycle.md` defines note semantics and review behavior.
- `obsidian.md` covers the human browsing layer.

## How to add docs

- Put installation and onboarding steps in `setup-guide.md`.
- Put configuration keys and defaults in `configuration.md`.
- Put API or MCP tool behavior in `tools-reference.md`.
- Put design changes and subsystem explanations in `architecture.md`.
- Put note status or lifecycle changes in `note-lifecycle.md`.
- Put vault UI or navigation changes in `obsidian.md`.
- Keep each page focused on one topic and link to the relevant page instead of duplicating content.
