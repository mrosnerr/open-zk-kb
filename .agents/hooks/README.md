# Project Agent Rules

Rules are Markdown files with YAML frontmatter that guide agent behavior.

## Frontmatter Fields

```yaml
---
description: "Brief explanation of what this rule enforces"
alwaysApply: true          # Render inline in every prompt (default: false)
globs: ["src/**/*.ts"]     # Only active when editing matching files (optional)
condition: "regex pattern" # Optional harness-specific stream condition
interruptMode: "always"    # Optional harness-specific interruption mode
scope: "tool-only"         # Optional harness-specific application scope
---
```

`description`, `alwaysApply`, and `globs` are standard rule metadata. Some
harnesses also support stream-condition rules using `condition`,
`interruptMode`, and `scope`; these can activate a rule or interrupt generation
when an output pattern matches.

## Rule Types

### Always-Apply Rules
Set `alwaysApply: true`. Renders inline in the system prompt on every turn.
Use sparingly — each always-apply rule consumes context window on every request.

### Glob-Scoped Rules
Set `globs: ["pattern"]`. Only active when the agent is editing files matching the glob.
Some harnesses make these rules available for on-demand loading.


## Example

```markdown
---
description: "Enforce early returns over nested conditionals"
globs: ["src/**/*.ts"]
---

When writing conditional logic, prefer early returns over nested if/else blocks.
This keeps the happy path at the lowest indentation level.
```
