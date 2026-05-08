<%*
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const esc = (s) => s ? s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') : '';
const bail = async () => { const f = app.vault.getAbstractFileByPath(tp.file.path(true)); if (f) await app.vault.trash(f, true); };
const title = await tp.system.prompt("Preference title");
if (!title) { await bail(); return; }
const preference = await tp.system.prompt("Describe this preference");
if (!preference) { await bail(); return; }
const ts = tp.file.title.slice(0, 16);
await tp.file.move(`preferences/${ts}-${slug(title)}`);
-%>
---
kind: personalization
status: permanent
lifecycle: living
type: atomic
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
summary: "<% esc(preference) %>"
guidance: "<% esc(preference) %>"
tags: []
---

# <% title %>

## Preference
<% preference %>

## Context
<% tp.file.cursor() %>

## Examples
- ✅
- 🚫
