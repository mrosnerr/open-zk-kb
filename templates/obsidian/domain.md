<%*
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const esc = (s) => s ? s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') : '';
const bail = async () => { const f = app.vault.getAbstractFileByPath(tp.file.path(true)); if (f && (Date.now() - f.stat.ctime < 60000)) await app.vault.trash(f, true); };
const pf = app.vault.getAbstractFileByPath("projects");
const existing = pf && pf.children ? pf.children.filter(f => f.children).map(f => f.name).sort() : [];
const options = [...existing, "＋ New project…"];
const sel = await tp.system.suggester(options, options, false, "Select project");
if (!sel) { await bail(); return; }
const rawProject = sel === "＋ New project…" ? await tp.system.prompt("Project name (slug)") : sel;
if (!rawProject) { await bail(); return; }
const project = sel === "＋ New project…" ? slug(rawProject) : rawProject;
if (!project) { await bail(); return; }
const role = await tp.system.prompt("What is the agent's role in this project? (one line)");
if (!role) { await bail(); return; }
await tp.file.move(`projects/${project}/domain`);
-%>
---
kind: domain
status: permanent
lifecycle: living
type: atomic
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
summary: "<% esc(role) %>"
guidance: "<% esc(role) %>"
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
