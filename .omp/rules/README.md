# OMP Rules

Rules are markdown files with YAML frontmatter that control agent behavior.
OMP discovers rules from this directory automatically.

## Frontmatter Fields

```yaml
---
description: "Brief explanation of what this rule enforces"
alwaysApply: true          # Render inline in every prompt (default: false)
globs: ["src/**/*.ts"]     # Only active when editing matching files (optional)
condition: "regex pattern"  # TTSR: activate when model output matches (optional)
interruptMode: "always"     # TTSR interrupt scope: never | prose-only | tool-only | always
scope: "tool-only"         # Where the rule applies: prose-only | tool-only | always
---
```

## Rule Types

### Always-Apply Rules
Set `alwaysApply: true`. Renders inline in the system prompt on every turn.
Use sparingly — each always-apply rule consumes context window on every request.

### Glob-Scoped Rules
Set `globs: ["pattern"]`. Only active when the agent is editing files matching the glob.
Listed in a rules block with `rule://<name>` instructions so the agent can load on demand.

### TTSR (Time-Traveling Stream Rules)
Set `condition: "pattern"` with `interruptMode`. The rule sits dormant until the model
output matches the regex pattern, then interrupts mid-generation to inject the rule.
Use for enforcing conventions the model tends to violate despite instructions.

## Example

```markdown
---
description: "Enforce early returns over nested conditionals"
globs: ["src/**/*.ts"]
---

When writing conditional logic, prefer early returns over nested if/else blocks.
This keeps the happy path at the lowest indentation level.
```
