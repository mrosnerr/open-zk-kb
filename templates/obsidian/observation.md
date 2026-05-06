<%*
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const scope = await tp.system.suggester(
  ["General", "Project"], ["general", "project"], false, "Scope"
);
let project = null;
if (scope === "project") {
  const pf = app.vault.getAbstractFileByPath("projects");
  const existing = pf ? pf.children.filter(f => f.children).map(f => f.name).sort() : [];
  const options = [...existing, "＋ New project…"];
  const sel = await tp.system.suggester(options, options, false, "Select project");
  project = sel === "＋ New project…" ? await tp.system.prompt("Project name (slug)") : sel;
}
const title = await tp.system.prompt("Observation title");
const summary = await tp.system.prompt("Describe what you observed");
const ts = tp.file.title.slice(0, 16);
const dir = project ? `projects/${project}/observations` : "general/observations";
await tp.file.move(`${dir}/${ts}-${slug(title)}`);
-%>
---
kind: observation
status: fleeting
lifecycle: snapshot
type: atomic
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
summary: "<% summary %>"
guidance: ""
tags:
<% project ? `  - project:${project}` : "" %>
---

# <% title %>

## What I Saw
<% tp.file.cursor() %>

## Where


## Why It Matters


## Implications
