---
# TTSR = Time-Traveling Stream Rules (OMP-specific).

#
# TTSR monitors the model's output token stream during generation. When a
# regex in `condition` matches, OMP interrupts mid-generation, injects the
# rule body as corrective context, and forces the model to retry.
#
# This rule catches the model claiming it will "remember" something without
# actually calling `knowledge-store`. No other supported client (Claude Code,
# Cursor, Windsurf, Zed, OpenCode) has an equivalent mid-generation
# interruption mechanism — this rule is only effective on OMP.
#
# `interruptMode: prose-only` ensures the rule only fires on the model's text
# output, not on tool call arguments (where "remember" might appear innocuously).
#
# See: OMP docs `ttsr-injection-lifecycle.md` for the full TTSR runtime spec.
condition:
  - "I'll (remember|keep that in mind|make a note|note that for)"
  - "I'll store that (later|after|when)"
interruptMode: prose-only
---
You said you'll remember something, but you haven't called `knowledge-store` yet.
Saying "I'll remember" does not persist anything — memory is lost between sessions unless stored via the tool.
Call `knowledge-store` NOW with the appropriate kind, summary, and guidance before continuing.
