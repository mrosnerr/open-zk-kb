---
name: kb-session-review
description: Review this session's knowledge base usage. Use when the user asks whether the KB was updated, what was captured, if anything was missed, or wants a session retrospective on knowledge capture quality.
---

Review this session's knowledge base usage. Score each area and act on gaps.

## 1. Search discipline

Scan the conversation for moments where prior context would have helped — debugging, architecture decisions, preference questions, repeated explanations. For each:
- Was knowledge-search called before acting?
- If called, was the query specific enough to surface relevant notes?
- Were results used or ignored?

## 2. Capture precision
First inspect session-created notes for overcapture: progress, transient outcomes, redundant concepts, immediately resolved findings, or facts better housed in code, Git, issues, OpenSpec, documentation, or logs. Report defects, but keep archive/delete changes subject to approval. Then identify only missed candidates that pass novelty, durability, behavioral-value, and canonical-home gates. Do not store plausible candidates automatically. Zero qualifying candidates is a successful review.

## 3. Storage quality

For each knowledge-store call made this session:
- Correct kind? (decision vs observation vs preference, etc.)
- Title scannable (3–6 words, not a sentence)?
- Summary captures the one-line takeaway?
- Guidance is an imperative instruction a future agent can act on?
- One concept per note, or bundled?

## 4. Output

Summarize as a scorecard:

| Area | Score | Notes |
|------|-------|-------|
| Search discipline | 🟢/🟡/🔴 | |
| Capture precision | 🟢/🟡/🔴 | |
| Storage quality | 🟢/🟡/🔴 | |

Then list specific actions taken, qualified notes stored this session, searches that should have happened, and any remaining gaps. Capture count is not a success metric.
