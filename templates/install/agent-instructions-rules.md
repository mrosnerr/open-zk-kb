## Knowledge Base (open-zk-kb)

BEFORE responding to any message, `knowledge-search` for relevant context. Follow each note's `<guidance>` tag. If the user says "remember", "always", "never", "I prefer", or corrects you, call `knowledge-store` FIRST, then proceed.

| Question | Tool |
|----------|------|
| Find notes about X | `knowledge-search` with natural language query |
| How many notes? KB health? | `knowledge-maintain` with `action: "stats"` |
| What's in project X? | `knowledge-overview` with `project` |
| Get a specific note by ID | `knowledge-get` with `noteId` |
| Save something I learned | `knowledge-store` with kind, summary, guidance |
| What template for a decision? | `knowledge-template` with `kind: "decision"` |
| Import from past sessions | `knowledge-mine` with candidates array |
| Save a URL for later | `knowledge-ingest` then `knowledge-store` |
| Review stale notes | `knowledge-maintain` with `action: "review"` |
| Open vault in Obsidian | `knowledge-open` |
