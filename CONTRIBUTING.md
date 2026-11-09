# Contributing to Resolv Room

Thanks for helping. The project is in its design phase, so the most useful contributions right now are spec review, threat-model review and runner ideas.

## Development setup

Requirements: Node.js 22 or newer and pnpm 10.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Spec first

The protocol lives in `spec/` and is separate from any implementation.

- Behavior changes start in the markdown specs and the JSON Schemas under `spec/schemas/`.
- Every schema change needs a matching example in `spec/examples/` and a test in `packages/protocol/test/`.
- Security-relevant behavior (permission decisions, path handling, identity checks) needs a test that fails without the change.

## Runners

A runner starts one kind of agent headless, passes it the session context, maps the permission profile to the agent's own restrictions, and returns the answer. Adding support for a new agent is a good first contribution; open a "Runner request" issue to discuss the agent's headless mode and how it can be restricted to read-only.

## Pull requests

- Keep them small and focused.
- Explain the why in the description.
- Make sure `pnpm typecheck` and `pnpm test` pass.

By contributing you agree that your contribution is licensed under the same terms as the project: MIT or Apache-2.0, at the user's option.
