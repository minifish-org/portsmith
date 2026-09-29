# Security

Portsmith is experimental. There is no production-hardening or supported-version guarantee yet.

Agent file and shell tools execute with the local user's permissions. A working directory is not a sandbox. Treat source files, model responses, skills, extensions, and tool output as untrusted. Use an isolated environment for untrusted workloads and restrict credentials and network access outside the application when necessary.

Keep API keys, `.env` files, raw sessions, and private tool output out of issues and commits. Session files may contain sensitive prompts and tool results. Test acceptance is a correctness mechanism, not a security boundary.

Report a suspected vulnerability privately to the maintainer at i@minifish.org, with a minimal reproduction and affected revision. Do not post exploit details or secrets in a public issue. No response-time SLA is promised.
