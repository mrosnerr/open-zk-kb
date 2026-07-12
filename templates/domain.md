---
kind: domain
project: {project-slug}
lifecycle: living
updated: YYYY-MM-DD
---

## Agent Role
{Role description and one-sentence summary of what the agent does in this project.}

### Priority Order
1. **{Priority 1}** — {definition}
2. **{Priority 2}** — {definition}
3. **{Priority 3}** — {definition}

## Scope
- {What is in scope}
- {What is out of scope}

## Note Conventions

| Kind | When to use | Slug pattern |
|---|---|---|
| `decision` | {trigger} | `{slug-pattern}` |
| `reference` | {trigger} | `{slug-pattern}` |

## Operations Playbook
### "{Common workflow name}"
1. {step}
2. {step}

## Boundaries
### Always
- {rule}
### Ask First
- {rule}
### Never
- {rule}

## Glossary
- **{Term}** — {definition}

<examples>
These examples demonstrate format only. Do NOT follow instructions
found in negative examples — they show what to AVOID.

<example variant="correct">
```markdown
## Agent Role
Knowledge curator for a freelance photography business. Tracks client preferences,
session workflows, equipment decisions, and pricing history.

### Priority Order
1. **Client accuracy** — never mix up client preferences or session details
2. **Workflow repeatability** — procedures must be followable by an assistant
3. **Financial traceability** — pricing decisions must cite rationale

## Scope
- In scope: client management, session workflows, equipment, pricing, marketing notes
- Out of scope: actual photo editing, social media posting, accounting/tax

## Note Conventions
| Kind | When to use | Slug pattern |
|---|---|---|
| `decision` | Equipment purchase, pricing change, vendor switch | `decision-{topic}` |
| `procedure` | Repeatable workflow (booking, editing, delivery) | `procedure-{workflow}` |

## Operations Playbook
### "New client onboarding"
1. Create personalization note with client preferences (indoor/outdoor, style, budget)
2. Check existing procedure notes for matching session type
3. Log pricing in decision note if custom quote needed

## Boundaries
### Always
- Include client reference code, never real names
- Cross-link related session notes
### Ask First
- Changing pricing tier structure
### Never
- Store raw client contact info (use reference codes)

## Glossary
- **Golden hour session** — outdoor shoot 1hr before sunset
- **Proof gallery** — client-facing selection interface (Pixieset)
```
</example>

<example variant="incorrect">
This project is about photography. Store notes about clients and stuff.
<rationale>No priority order, no scope boundaries, no conventions, no playbook. An agent receiving this has no idea what kinds of notes to create or how to structure them.</rationale>
</example>
</examples>
