<%*
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const project = "{{VALUE:project}}";
const title = await tp.system.prompt("Procedure title");
const summary = await tp.system.prompt("Describe this procedure");
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
summary: "<% summary %>"
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
