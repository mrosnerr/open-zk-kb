<%*
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const esc = (s) => s ? s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') : '';
const bail = async () => { const f = app.vault.getAbstractFileByPath(tp.file.path(true)); if (f && (Date.now() - f.stat.ctime < 60000)) await app.vault.trash(f, true); };
const project = "{{VALUE:project}}";
const title = await tp.system.prompt("Resource title");
if (!title) { await bail(); return; }
const url = await tp.system.prompt("Resource URL");
if (!url) { await bail(); return; }
const summary = await tp.system.prompt("Describe this resource");
if (!summary) { await bail(); return; }
const ts = tp.file.title.slice(0, 16);
await tp.file.move(`projects/${project}/resources/${ts}-${slug(title)}`);
-%>
---
kind: resource
status: permanent
lifecycle: living
type: atomic
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
summary: "<% esc(summary) %>"
guidance: ""
tags:
  - project:<% project %>
---

# <% title %>

## What It Is
<% tp.file.cursor() %>

## Why It's Useful


## Key References
- [<% url %>](<% url %>)

## Notes from Use
