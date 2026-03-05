# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email: **security@open-zk-kb.dev**

You should receive an acknowledgment within 48 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

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

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| < 2.0   | No        |
