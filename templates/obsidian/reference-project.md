<%*
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const esc = (s) => s ? s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') : '';
const bail = async () => { const f = app.vault.getAbstractFileByPath(tp.file.path(true)); if (f) await app.vault.trash(f, true); };
const project = "{{VALUE:project}}";
const title = await tp.system.prompt("Reference title");
if (!title) { await bail(); return; }
const summary = await tp.system.prompt("Describe this reference");
if (!summary) { await bail(); return; }
const sourceUrl = await tp.system.prompt("Source URL (leave empty if none)", "");
const ts = tp.file.title.slice(0, 16);
await tp.file.move(`projects/${project}/references/${ts}-${slug(title)}`);
-%>
---
kind: reference
status: fleeting
lifecycle: snapshot
type: atomic
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
summary: "<% esc(summary) %>"
guidance: ""
tags:
  - project:<% project %>
---

# <% title %>

<% sourceUrl ? `> Source: ${sourceUrl}` : "" %>

## Key Excerpts
<% tp.file.cursor() %>

## Original Content
