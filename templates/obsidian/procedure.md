<%*
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const esc = (s) => s ? s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') : '';
const bail = async () => { const f = app.vault.getAbstractFileByPath(tp.file.path(true)); if (f) await app.vault.trash(f, true); };
let scope = "{{VALUE:scope}}";
if (!scope || scope.includes("VALUE:scope")) {
  scope = await tp.system.suggester(
    ["General", "Project"], ["general", "project"], false, "Scope"
  );
}
if (!scope) { await bail(); return; }
let project = null;
if (scope === "project") {
  const pf = app.vault.getAbstractFileByPath("projects");
  const existing = pf && pf.children ? pf.children.filter(f => f.children).map(f => f.name).sort() : [];
  const options = [...existing, "＋ New project…"];
  const sel = await tp.system.suggester(options, options, false, "Select project");
  if (!sel) { await bail(); return; }
  const rawProject = sel === "＋ New project…" ? await tp.system.prompt("Project name (slug)") : sel;
  if (!rawProject) { await bail(); return; }
  project = sel === "＋ New project…" ? slug(rawProject) : rawProject;
  if (!project) { await bail(); return; }
}
const title = await tp.system.prompt("Procedure title");
if (!title) { await bail(); return; }
const summary = await tp.system.prompt("Describe this procedure");
if (!summary) { await bail(); return; }
const ts = tp.file.title.slice(0, 16);
const dir = project ? `projects/${project}/procedures` : "general/procedures";
await tp.file.move(`${dir}/${ts}-${slug(title)}`);
-%>
---
kind: procedure
status: fleeting
lifecycle: living
type: atomic
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
summary: "<% esc(summary) %>"
guidance: ""
tags:
<% project ? `  - project:${project}` : "" %>
---

# <% title %>

## Trigger
<% tp.file.cursor() %>

## Prerequisites
-

## Steps
1.
2.
3.

## Verification


## Common Failure Modes
- **Failure** — recovery

## Changelog
- <% tp.date.now("YYYY-MM-DD") %> — Created
