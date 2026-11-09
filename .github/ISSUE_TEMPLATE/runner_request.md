---
name: Runner request / good first runner
about: Add support for another agent (a "runner" starts the agent headless and maps its permissions)
labels: runner, good first issue
---

**Agent**
Name, vendor and how it is normally started (CLI, API, ...).

**Headless mode**
How can it be invoked non-interactively with a prompt, and how does it return its answer?

**Permission mapping**
How can the agent be restricted to read-only? Does it have a native permission prompt we can bridge for `ask` mode?

**Are you willing to implement it?**
Runners are small packages that implement the `Runner` interface. See `CONTRIBUTING.md`.
