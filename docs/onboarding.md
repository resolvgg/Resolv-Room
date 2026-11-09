# Onboarding: first install

Status: implemented, except where marked. The first test on two real machines over a real tailnet has not been done yet (see [`testing.md`](testing.md)).

**Goal:** two machines paired and a test consult working in about five minutes, safe by default (`ask` mode from the start).

## What the user does

One command per machine:

```
curl -fsSL https://raw.githubusercontent.com/resolvgg/Resolv-Room/main/install.sh | sh
```

It checks Node 22+ and git, downloads the source into `~/.resolvroom/src`, builds it, links `~/.local/bin/resolvroom` and starts `resolvroom init`. It never uses `sudo`. (Read the script first if you like: it is short. `sh -s -- --yes` passes `--yes` to `init` to accept the defaults without questions.) Later: `npm i -g resolvroom` once the package is published.

`resolvroom init` is a guided setup in six steps. Each step says what it found and asks before it changes anything outside Resolv Room. `resolvroom doctor` re-runs the checks later.

### 1. This machine

Hostname, OS, Node, whether it looks like a headless server (Linux with no desktop session), and which agents are installed (Claude Code, OpenClaw, Hermes). Only the Claude Code runner exists today.

### 2. Tailscale

Reads `tailscale status`: this machine's node name and address. If Tailscale is missing or logged out, `init` stops with the install link.

### 3. Tags

`init` asks one question: *may this machine run requests unattended (auto mode) for peers you later grant it to?* No (default) means `tag:resolvroom` + `tag:resolvroom-ask`; yes means `tag:resolvroom` + `tag:resolvroom-auto`. It then runs

```
tailscale set --advertise-tags=<the machine's other tags, plus the two above>
```

(`--advertise-tags` replaces the whole list, so existing tags are kept) and waits until `tailscale status` shows them. Three outcomes:

- **It works.** Done.
- **The tags are not declared in your tailnet policy yet** (the first machine on a tailnet). `init` prints the `tagOwners`/`acls` blocks to add at <https://login.tailscale.com/admin/acls>, waits for you to press Enter after saving, and retries. This is done once for the whole tailnet. Editing the policy for you would need an API token, so it is left to you for now.
- **Permission denied.** `tailscale set` often needs root on Linux; `init` suggests `sudo tailscale set ...` (or `sudo tailscale set --operator=$USER` once).

It also records the machine's `ceiling` (`ask`, or `auto` if you said yes). That never grants anything by itself: `auto` is still granted per peer, with a folder and an expiry.

### 4. Claude Code

If Claude Code is installed, `init` runs `resolvroom install-claude`: it shows the two changes (the `/room` command file and `claude mcp add ...`) and applies them after you confirm.

### 5. Background service

On a server this is the recommended default. `init` asks which folder the agent may read after you approve a request (default: the current folder), writes a `systemd --user` unit (Linux) or a `launchd` agent (macOS) and starts it. On a server also run `loginctl enable-linger $USER` so it survives logout.

A background service has no terminal, so requests that need approval wait in a queue on that machine. Answer them with:

```
resolvroom approvals --watch      # asks about each new request
resolvroom approvals              # list; then:  resolvroom approve <id>  |  resolvroom deny <id>
```

No answer within `ask.timeout_s` (default 120 s) is a no. Run in the foreground (`resolvroom start`), the same prompt appears in that terminal.

### 6. Pair two machines

On machine B:

```
resolvroom pair
```

It prints a code like `K7QM-3XP9`, valid for five minutes, single use, three attempts. On machine A:

```
resolvroom pair notebook-b K7QM-3XP9
```

B checks the code, and (on a real tailnet) that A's node carries `tag:resolvroom`. Both sides then list each other in `ask` mode, read-only: a pairing never grants `auto`. Raising it is a separate, deliberate step: `resolvroom peer allow notebook-a --mode auto --scope <folder> --expires 8h`. Protocol details: [`protocol-v0.1.md`](../spec/protocol-v0.1.md), section 3.1.

Pairing only works while both daemons are running. That is the rule "the connection starts only when both sides are installed and up".

### 7. Test

```
resolvroom consult notebook-b "ping"
```

then, in Claude Code, `/room <what you want solved>`.

## Example session

```
$ curl -fsSL https://raw.githubusercontent.com/resolvgg/Resolv-Room/main/install.sh | sh
Installed: ~/.local/bin/resolvroom
Starting the guided setup (resolvroom init)...

1/6  This machine
  ✔ vps-1 (linux/x64, Node 22.x, headless: looks like a server)
  ✔ Agents found: claude-code (2.x)
2/6  Tailscale
  ✔ Node name "vps-1", address 100.64.0.7
3/6  Tags
  ? May this machine run requests unattended (auto mode) for peers you later grant it to? [y/N] n
  ✔ Tags applied: tag:resolvroom, tag:resolvroom-ask
4/6  Claude Code
  ... shows the two changes ... Proceed? [y/N] y
5/6  Background service
  ? Run the daemon as a background service (recommended on a server)? [Y/n] y
  ✔ service enabled and started
6/6  Next
  1. Pair with the other machine:  here: resolvroom pair   there: resolvroom pair vps-1 <code>
  2. approvals wait in a queue:    resolvroom approvals --watch
```

## Mode rules during onboarding

- The mode is always decided by the machine that **receives** requests.
- A new peer starts at `ask`, read-only. Raising it is a separate, deliberate step: `resolvroom peer allow notebook-a --mode auto --scope <folder> --expires 8h`.
- A session can only lower the mode, never raise it.

## Failure cases

| Situation | What the user sees |
|---|---|
| Tailscale not installed or logged out | `doctor` stops with the exact fix and a link to the Tailscale install page |
| Tag missing or not applied yet | The wizard waits and re-checks; it never continues silently |
| Pair code expired or wrong 3 times | The pairing window closes; run `resolvroom pair` again |
| Daemon has no terminal and nobody answers | The request is denied after `ask.timeout_s`; answer with `resolvroom approvals --watch` |
| Peer offline during `consult` | Immediate "peer unavailable"; no session is created |
| Agent not installed on the peer | `session.reject` with `agent_unavailable` and a readable message |
