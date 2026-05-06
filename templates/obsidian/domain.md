<%*
const pf = app.vault.getAbstractFileByPath("projects");
const existing = pf ? pf.children.filter(f => f.children).map(f => f.name).sort() : [];
const options = [...existing, "＋ New project…"];
const sel = await tp.system.suggester(options, options, false, "Select project");
const project = sel === "＋ New project…" ? await tp.system.prompt("Project name (slug)") : sel;
const role = await tp.system.prompt("What is the agent's role in this project? (one line)");
await tp.file.move(`projects/${project}/domain`);
-%>
---
kind: domain
status: permanent
lifecycle: living
type: atomic
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
summary: "<% role %>"
guidance: "<% role %>"
tags:
  - project:<% project %>
---

## Agent Role
<% role %>

### Priority Order
1. <% tp.file.cursor() %>
2.
3.

## Scope
- In scope:
- Out of scope:

## Note Conventions
| Kind | When to use | Slug pattern |
|---|---|---|
| `decision` | | |
| `procedure` | | |

## Operations Playbook
### "Workflow Name"
1.

## Boundaries
### Always
-
### Ask First
-
### Never
-

## Glossary
- **Term** — definition
