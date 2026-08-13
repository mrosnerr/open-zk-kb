---
# TTSR = Time-Traveling Stream Rules (OMP-specific).
condition:
  - "I'll (remember|keep that in mind|make a note|note that for)"
  - "I'll store that (later|after|when)"
interruptMode: prose-only
---
A memory promise must be truthful. If the user explicitly requested an enduring item and it passes the precision gate (novel, durable, behavior-changing, and canonical here), and persistence is safe and available, call `knowledge-store` in this turn before claiming it is remembered. If persistence is unavailable or unsafe, correct the promise without claiming storage. If the content fails the gate or is unqualified, say it was not stored; do not command unrelated storage. Never claim persistence without a successful tool call.
