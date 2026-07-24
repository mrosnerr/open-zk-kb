# Review Core

The `review` module is an internal, read-only evaluation boundary. Rules use immutable `NoteFacts` snapshots and emit structured findings; renderers remain responsible for the existing user-facing text. Built-in rule IDs use `<profile>.<name>` (for example `lifecycle.review-due`) and versions are separate from fingerprints. This module has no public tool, persistence, or plugin contract.
