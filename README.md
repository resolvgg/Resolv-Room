# Resolv Room

A self-hosted bridge that lets AI agents on different machines work on a problem together, over your own private network.

> **Status: pre-alpha, first testable version.** `consult` works end to end between two daemons (with a mock agent, a real Claude Code or Hermes Agent), with `ask`/`auto` permissions, an approval prompt, logs, an MCP server and a `/room` command. It has been tried on two real machines over a tailnet (install, tags, pairing by code, approval queue, a consult answered by Claude Code). See [`docs/testing.md`](docs/testing.md) to try it, and what is and is not verified.

## Install (one command per machine)

```
curl -fsSL https://raw.githubusercontent.com/resolvgg/Resolv-Room/main/install.sh | sh
```

It needs Node 22+ and git, installs under `~/.resolvroom` and `~/.local/bin` (no `sudo`), then starts `resolvroom init`: it identifies the machine, sets the Tailscale tags, registers `/room` in Claude Code and/or Hermes and can install a background service. Then pair two machines: `resolvroom pair` on one, `resolvroom pair <name> <code>` on the other. Details: [`docs/onboarding.md`](docs/onboarding.md).

## Update

```
resolvroom update
```

It pulls the latest version into `~/.resolvroom/src`, rebuilds it and restarts the background service. Your settings, peers and agent registrations stay as they are. Running the `curl … | sh` line again on a machine that is already set up does the same (it skips the guided setup; `resolvroom init` redoes it).

## Try it in two minutes

```
pnpm install
pnpm demo:local
```

Two daemons start on your machine, one consults the other, and the approval prompt is shown and answered. Then see [`docs/testing.md`](docs/testing.md) for real Claude Code and for the two-machine Tailscale test.

## The `/room` command

After `resolvroom install-claude`, in Claude Code:

```
/room which name is better for this function, isAdmin or hasAdminRole?
```

The agent works on your request first, builds a proposal, sends it to the agent on the other machine with the `consult` tool, and comes back with its own conclusion plus the second opinion. (`/mcp__resolvroom__room` is the same flow exposed by the MCP server.)

In Hermes Agent, `resolvroom install-hermes` registers the same MCP server (`hermes mcp add`) and a `room` skill, so `/room …` works there too.

## Send files

```
resolvroom send isantoandrethinkpadai ~/projetos/igestao -m "for review"
```

The owner of the other machine sees what is coming (count, size, sample of paths) and accepts or declines. Accepted files land in `~/resolvroom-inbox/<your machine>/<date>-<name>/` there, never anywhere else, checked by SHA-256. Secrets (`.env`, keys, `~/.ssh`…) are never sent; `node_modules`, build output and `.git` are left out unless you add `--include-deps` / `--include-git`. Agents can do the same with the `send_files` tool (your agent asks you first), and a consult can then read what you sent.

## Agents that answer

The daemon wakes one local agent to answer requests from other machines (`resolvroom start --agent …`, chosen in `init`):

| Agent | What it can touch |
|---|---|
| `claude-code` | In ask mode, reads the shared folder after you approve; in auto mode, the granted folders (and edits/web if granted). If it needs a file outside them, it **asks you mid-run** (one file at a time; secrets are always refused). Never the shell. |
| `hermes` | Only the text of the request (plus web search in auto mode, if granted). Hermes' file tools cannot be confined to a folder, so it gets none. |
| `mock` | Nothing; echoes the request. For testing. |

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
  core/          config, JSONL logs and the consult engine (host and guest)
  daemon/        HTTP transport, Tailscale identity, local control socket, approval prompt
  runner/        wakes the local agent headless (Claude Code, and a mock for testing)
  mcp/           MCP server (stdio): consult and peers tools, /room prompt
apps/
  resolvroom/    the CLI
docs/            onboarding flow, testing guide, design notes
```

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Monorepo, licenses, CI | done |
| 1 | Protocol v0.1, permission model, onboarding design | done |
| 2 | Core: consult sessions, limits, logs | done (`room` with several rounds is next) |
| 3 | Tailscale transport: `whois`, allowlist, pairing by code | implemented, untested on a real tailnet |
| 4 | Local MCP server and `/room` | done |
| 5 | Runners | Claude Code, Hermes (text only) and mock done; OpenClaw planned; Hermes file access via a confined backend planned |
| 6 | CLI | `init`, `pair`, `start`, `service`, `approvals`, `peer`, `consult`, `mcp`, `doctor`, `install-claude`, `install-hermes`, `update`, `send`; `watch`, `export` planned |
| 7 | Multi-round `room`, per-action approval, first release | per-action approval for reads outside the folders done (Claude Code); the rest planned |

## Contributing

Specs come first: protocol or permission changes start as a change to `spec/` and the schemas. See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: [`SECURITY.md`](SECURITY.md).

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
