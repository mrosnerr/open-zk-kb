## Knowledge Base (open-zk-kb)
Persistent cross-session memory via `knowledge-*` MCP tools.
**Before work:** search project-visible knowledge with `knowledge-search` and follow relevant guidance.

**Precision-first capture (default: no new note):** Call `knowledge-store` for routine agent-initiated knowledge only when all four gates pass:
- **Novel:** search found no adequate existing note.
- **Durable:** useful beyond this task and transient branch, session, subscription, or configuration.
- **Behavior-changing:** materially changes a future decision or action.
- **Canonical here:** the knowledge base is a better home than code, tests, Git, issues, OpenSpec, documentation, generated logs, or another note.

Do not routinely capture progress, completed-work or release summaries, cleanup reports, commits, milestones, immediately resolved findings, transient research, or facts authoritative elsewhere. Zero captures is a successful result. When a candidate qualifies, capture it before its evidence is lost; do not harvest indiscriminately at session end. Explicit requests to remember enduring qualified knowledge receive prompt handling, subject to safety, scope, novelty, and canonical-note checks.

Search before creating. Reuse an adequate existing note; use a supported reviewed update for a canonical living note when available. If no safe update path exists, do not create a duplicate. Normally create zero or one agent-initiated note per task; separate genuinely independent durable concepts need separate justification. Each note is one concept with `summary` and imperative `guidance`.

**Project scope:** pass the current project on routine calls; never create global knowledge routinely. `index` and `log` are server-generated and must not be created manually.
**Full detail:** `knowledge-template --kind {kind}` and the `open-zk-kb` skill where supported.
