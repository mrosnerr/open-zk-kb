## Knowledge Base (open-zk-kb)
Cross-session memory via `knowledge-*` MCP tools. Retrieve only when durable memory can materially affect the task.

**Canonical ownership:**
- **OpenSpec:** active scope, requirements, design, tasks.
- **Code/tests:** implemented behavior.
- **Maintained docs:** supported usage, architecture.
- **Git:** integrated history. **Issues:** unresolved coordination.
- **Knowledge base:** durable agent memory lacking a better home.

Injection is independent of persistence: automatic note context carries only applicable permanent preferences (max 12; 800-token estimate)—never bodies, inventory, resources, activity, requirements, design, progress.

**Precision-first capture (default: no new note):** Call `knowledge-store` only when gates pass: **Novel:** no adequate existing note; **Durable:** useful beyond task or transient state; **Behavior-changing:** changes future action; **Canonical here:** better here than the authorities above. Zero captures is a successful result.

When relevant, use `knowledge-search` in compact mode; escalate once to exact-ID `knowledge-get`. Reuse an adequate existing note or supported reviewed update. If no safe update path exists, do not create a duplicate. Handle explicit enduring-memory requests under these gates. Do not routinely capture plans, tasks, progress, commits, completed-work/release summaries, or transient research. Preserve existing notes; rehome only after destination verification; archive and delete separately. Pass the current project on routine calls; never create global knowledge routinely. `index` and `log` are server-generated.

**Client pointer:** use `skill://open-zk-kb`.
