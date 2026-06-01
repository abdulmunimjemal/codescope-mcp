# Security Policy

## Scope

codescope is **local-first**: it parses your code into a local SQLite database
and serves it over a stdio MCP connection. It makes no network calls, requires no
credentials, and sends no telemetry. The main security surface is therefore:

- Parsing untrusted source files (handled by sandboxed tree-sitter WASM grammars).
- The `install` command, which writes MCP server entries into agent config files.

## Reporting a vulnerability

Please **do not open a public issue** for security reports. Email
**abdulmunimjemal@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal repo or file is ideal),
- the codescope version (`codescope --version`) and your OS/Node version.

You'll get an acknowledgement within a few days. Once a fix is available, a
patched release will be published to npm and the advisory disclosed.

## Supported versions

The latest published `0.x` release receives security fixes.
