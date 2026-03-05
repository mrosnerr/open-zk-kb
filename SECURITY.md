# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, use [GitHub's private vulnerability reporting](https://github.com/mrosnerr/open-zk-kb/security/advisories/new) to submit your report directly. This keeps the details confidential until a fix is available.

## Scope

- MCP server (`mcp-server.ts`)
- OpenCode plugin (`opencode-plugin.ts`)
- CLI installer (`setup.ts`)
- SQLite database handling
- Configuration file parsing
- API key handling and credential storage

## Out of Scope

- Vulnerabilities in upstream dependencies (report to the dependency maintainer directly)
- Issues requiring physical access to the machine
- Social engineering
