<%*
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const esc = (s) => s ? s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') : '';
const project = "{{VALUE:project}}";
const title = await tp.system.prompt("Procedure title");
if (!title) return;
const summary = await tp.system.prompt("Describe this procedure");
if (!summary) return;
const ts = tp.file.title.slice(0, 16);
await tp.file.move(`projects/${project}/procedures/${ts}-${slug(title)}`);
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
  - project:<% project %>
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
