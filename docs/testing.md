# Testing Resolv Room

Three levels, from "no setup" to "the real thing". Each says what it proves and what it does not.

## 0. Requirements

Node 22+ and pnpm 10. From the repository root:

```
pnpm install
pnpm build
```

## 1. Automated tests and the local demo (one machine, no Tailscale, no tokens)

```
pnpm test          # builds, then runs all packages (about 140 tests)
pnpm demo:local    # two real daemon processes talking over HTTP on 127.0.0.1
```

The demo starts two daemons (`alpha`, `beta`) with a **mock agent** (it only echoes), allows each peer on the other side, runs `resolvroom consult`, shows the approval prompt on `beta` being answered, and finally shows that a peer that is not on the allowlist is refused.

This proves the protocol, limits, allowlist, permission resolution, the approval prompt, the logs, the control socket and the MCP server. It does **not** prove Tailscale identity or a real agent.

Local mode uses `--insecure-dev-identity`: the daemon trusts a header that says who is calling. It refuses to run that way on anything but a loopback address. Never use it on a real network.

## 2. Real Claude Code on one machine (uses a few cents of tokens)

The Claude Code runner can be tested against your real `claude` binary:

```
RESOLVROOM_REAL_CLAUDE=1 pnpm --filter @resolvroom/runner test
```

It creates a temporary folder with a file, consults through the runner and checks that the agent read it. It was also checked manually that, with the flags the runner uses, reading a file **outside** the working folder is denied.

To try the real `/room` flow with a mock peer, in two terminals:

```
# terminal 1: the "other machine" (mock agent, answers prompts on the terminal)
RESOLVROOM_HOME=/tmp/rr-b node apps/resolvroom/dist/bin.js start --insecure-dev-identity --name notebook-b --port 7802 --agent mock

# terminal 2: your machine
export RESOLVROOM_HOME=/tmp/rr-a
node apps/resolvroom/dist/bin.js start --insecure-dev-identity --name alpha --port 7801 --agent mock &
node apps/resolvroom/dist/bin.js peer allow notebook-b --endpoint http://127.0.0.1:7802
RESOLVROOM_HOME=/tmp/rr-b node apps/resolvroom/dist/bin.js peer allow alpha --endpoint http://127.0.0.1:7801
node apps/resolvroom/dist/bin.js install-claude      # asks first
# restart Claude Code, then:  /room which name is better for this function, isAdmin or hasAdminRole?
```

`install-claude` registers the MCP server **without** the `RESOLVROOM_HOME` of terminal 2 unless the variable is exported when you run it (it is, above).

## 3. Two real machines over Tailscale

This is the test that matters and the one that has **not** been run yet. Take two machines on the same tailnet (A and B), both with Node 22, `pnpm build` done, and Claude Code installed.

1. **Install and set up.** Run the one-line installer above on both machines. `resolvroom init` sets the tags (it prints the policy blocks to paste in the Tailscale admin console the first time) and offers the background service.
2. **Doctor.** `resolvroom doctor` on both: Node, Tailscale name, the tag, Claude Code.
3. **Pair.** On B: `resolvroom pair` (prints a code). On A: `resolvroom pair <name-of-B> <code>`. Names are the Tailscale node names. (Or add each other by hand with `resolvroom peer allow <name>` on both sides.)
4. **Start.** On both, inside the project folder you are willing to share: `resolvroom start`. The daemon listens only on the Tailscale IP, port 7777.
5. **Consult.** On A: `resolvroom consult <name-of-B> "ping"`. B's terminal shows who is asking and what the agent can read; answer `y`. If B runs as a background service, answer with `resolvroom approvals --watch` on B.
6. **`/room`.** On A: `resolvroom install-claude`, restart Claude Code, then `/room <what you want solved>`.

What to look for: the prompt on B names A (from `whois`, not from the message); a third machine that is not allowed gets `not_allowed`; stopping B's daemon gives "peer unavailable" at once.

## Installer and guided setup

```
curl -fsSL https://raw.githubusercontent.com/resolvgg/Resolv-Room/main/install.sh | sh
```

Hermes: the runner was run against the real Hermes Agent 0.19 CLI (with a stand-in model server): the only tool offered to the model is the inert `todo` toolset, the configured MCP servers (including `resolvroom` itself) are excluded, and `install-hermes` registers the MCP server and the `/room` skill through the real `hermes mcp add`. Not tested: a real model behind Hermes. Opt-in test: `RESOLVROOM_REAL_HERMES=1 pnpm --filter @resolvroom/runner test`.

Tested here: the installer end to end from a local clone (download, build, link), `resolvroom init` against a fake `tailscale` binary (tags applied, other tags kept, policy-missing loop, sudo hint, no Tailscale), and `install-claude` against the real `claude mcp add` (it reports `Connected`). Not tested here: the real `tailscale set --advertise-tags` and a real tailnet policy, `systemd --user` and `launchd` (the generated files are unit-tested, starting them is not), and `curl | sh` from the real GitHub URL on a fresh machine.

## What has and has not been verified

| Area | Status |
|---|---|
| Protocol, schemas, permission resolver | automated tests |
| Consult host/guest, limits, idempotency, identity checks | automated tests (in-memory and real HTTP) |
| Approval prompt, terminal escape sanitising | automated tests |
| MCP tools and `/room` prompt/command | automated tests, plus a manual run with the real Claude Code and a mock peer |
| Claude Code runner flags | checked against Claude Code 2.1.319; opt-in real test |
| Tailscale `whois` / `status` parsing | unit tests with sample JSON written from the documented format; **not** checked against a real tailnet |
| Two machines over a real tailnet | **not tested** |
| Windows | not tested |

Known gaps in this version: `consult` only (no multi-round `room`), the `ask` approval is once per session (not per file or command), and `exec` is never granted.
