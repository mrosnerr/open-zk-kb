<%*
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const title = await tp.system.prompt("Preference title");
if (!title) return;
const preference = await tp.system.prompt("Describe this preference");
if (!preference) return;
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
summary: "<% preference %>"
guidance: "<% preference %>"
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
