# Resolv Room

A self-hosted bridge that lets AI agents on different machines work on a problem together, over your own private network.

> **Status: pre-alpha, design phase.** The protocol and the permission model are specified in [`spec/`](spec/). The daemon, MCP server and CLI are not implemented yet, so there is nothing to install today.

## The problem

You run more than one agent: Claude Code on one laptop, OpenClaw or Hermes on another. Each one sees only its own machine, and you end up as the human messenger copying context between them.

Resolv Room lets one agent **consult** another agent directly, or open a short multi-agent **room**, over a private Tailscale network. No cloud service sits in the middle, every session has limits, and every decision is logged.

## How it is designed to work

- **One daemon per machine.** It exposes a local MCP server to the agent on that machine and talks to the daemons on other machines through your tailnet. The agent never touches the network itself.
- **The side that starts a session is its host.** The host keeps the log, enforces limits (rounds, time, inactivity) and moderates turns. The next session can be hosted by the other machine. No central server is required.
- **Identity comes from Tailscale.** A daemon asks the local Tailscale which node is on the other end of a connection (`whois`) and checks its tags and a local allowlist. There are no tokens to create, copy or leak.
- **Two session kinds.** `consult`: one agent sends a proposal and the other answers once. `room`: several rounds with a moderator, until a result is accepted or a limit is hit.
- **Headless runners.** When a request arrives, the receiving daemon starts the local agent in headless mode through a *runner* (one small package per agent) and returns the answer, so the other machine does not need an open agent session.

## Permission modes

The machine that **receives** a request decides what the other side may do there. A requester can never raise its own permissions.

| | `ask` (default) | `auto` |
|---|---|---|
| Reading folders, using data, writing, running commands | The local human is prompted first: allow once, allow for this session, or deny | Allowed without prompting, **only** inside an explicit folder scope and the enabled capabilities |
| Outside the scope | Prompted | Prompted (or denied, if configured) |
| How it is granted | Default for every paired peer | Explicit opt-in per peer, with a folder scope and an expiry |
| Tailnet tag | `tag:resolvroom-ask` forces this mode | `tag:resolvroom-auto` makes a machine *eligible*; the local owner still has to grant it |

Credentials, keys, `.env` files and the Resolv Room config itself are on a hard deny list that no profile can override. Details: [`spec/permissions-v0.1.md`](spec/permissions-v0.1.md).

## Repository layout

```
spec/            protocol and permission specs (versioned) + JSON Schemas + examples
packages/
  protocol/      TypeScript types, schema validators and the reference permission resolver
docs/            onboarding flow and design notes
```

Planned packages: `core` (sessions, moderator, limits), `store` (append-only log), `transport-tailscale`, `mcp`, `runner` and one runner per agent, and the `resolvroom` CLI.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Monorepo, licenses, CI | done |
| 1 | Protocol v0.1, permission model, onboarding design | in progress |
| 2 | Core: sessions, moderator, limits, log | planned |
| 3 | Tailscale transport: `whois`, allowlist, pairing | planned |
| 4 | Local MCP server | planned |
| 5 | Runners (Claude Code first) | planned |
| 6 | CLI: `init`, `pair`, `consult`, `watch`, `export` | planned |
| 7 | First release | planned |

## Contributing

Specs come first: protocol or permission changes start as a change to `spec/` and the schemas. See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: [`SECURITY.md`](SECURITY.md).

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
