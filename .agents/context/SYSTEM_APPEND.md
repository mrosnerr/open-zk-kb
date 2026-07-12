# Project Agent Resources

- `context/` contains project context appended to agent prompts.
- `hooks/` contains rules. See [`../hooks/README.md`](../hooks/README.md).
- `skills/` contains custom commands.
- `capabilities/` contains extensions.
- `state/` contains ephemeral runtime state and is gitignored.

Some harnesses resolve internal URI schemes or compact context; consult that harness's documentation for its behavior.
