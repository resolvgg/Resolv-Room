# Onboarding: first install

Status: design. None of these commands exist yet; this document is the target behavior for the CLI (phase 6) and the transport (phase 3).

**Goal:** two machines paired and a test consult working in about five minutes, safe by default (`ask` mode from the start).

## What the user does

```
npm i -g resolvroom
resolvroom init
```

### 1. Diagnosis (`resolvroom doctor`, also run by `init`)

Checks and reports:

- Node version;
- Tailscale installed and logged in (`tailscale status`), the tailnet name and this machine's node name (MagicDNS);
- agents found on this machine (Claude Code, OpenClaw, Hermes) so the right runners are enabled;
- whether the node already carries `tag:resolvroom`.

### 2. Tailscale tags

The wizard prints the policy snippet to paste into the Tailscale admin console (see [`permissions-v0.1.md`](../spec/permissions-v0.1.md), section 5) and the command to tag this machine:

```
tailscale set --advertise-tags=tag:resolvroom,tag:resolvroom-ask
```

Use `tag:resolvroom-auto` instead of `-ask` only on a machine that should ever be eligible for auto mode. The wizard then **verifies** that the tag took effect. Editing the policy cannot be automated without an admin API key, so this is the only mandatory manual step.

Two setups:

- **strict** (default): tag plus allowlist;
- **lite** (`--no-tags`): allowlist only, with a visible warning that the network layer is not restricted. Auto mode is not available in lite.

### 3. Register the MCP server with the local agent

For each detected agent the wizard shows the exact change it will make to that agent's MCP config as a **diff** and applies it only after the user confirms. The same rule as `ask` mode applies to the installer itself. Optionally it also installs a short instructions snippet (for example a `CLAUDE.md` section) that tells the agent when to use `consult` and `room_open`.

### 4. Start the daemon

`resolvroom start` runs it in the foreground. During `init` the wizard offers, as an opt-in, to install it as a background service (`launchd` on macOS, `systemd --user` on Linux). It listens only on the Tailscale interface, port 7777 by default.

### 5. Pair two machines

On machine B:

```
resolvroom pair
```

It prints a short code, valid for five minutes, single use, at most three attempts. On machine A:

```
resolvroom pair notebook-b <code>
```

What happens:

1. A's daemon contacts B's daemon through the tailnet. B checks A's identity with `whois` and that A carries `tag:resolvroom`. The code proves the person at A is physically coordinating with the person at B, so another tagged node on the tailnet cannot start a pairing on its own.
2. **Each human confirms on their own machine** which mode to give the other side. The default is `ask`, read-only. For `auto` the wizard requires: a folder scope, an expiry (default 8 hours), explicit capabilities, and typing a confirmation. It explains the downgrade rules (ceiling, tag, expiry).
3. Both daemons write the peer into their allowlist (`~/.resolvroom/config.json`, [schema](../spec/schemas/config.schema.json)).

Pairing only works while both daemons are running. That is the rule "the connection starts only when both sides are installed and up".

### 6. Test

```
resolvroom consult notebook-b "ping"
```

Runs a read-only consult that asks the other agent to answer with its name and the effective mode. If it returns, the setup is complete.

## Example session

```
$ resolvroom init
✔ Node 22.x
✔ Tailscale: logged in as notebook-a (tailnet example.ts.net)
✔ Agents found: claude-code
✖ Tag tag:resolvroom not found on this node
  Paste this into the Tailscale admin console (ACLs):  [policy snippet printed here]
  Then run:  tailscale set --advertise-tags=tag:resolvroom,tag:resolvroom-ask
  Waiting for the tag... ✔
? Register the MCP server with Claude Code? (shows diff)  Yes
? Start resolvroom automatically at login?  No
Done. Next: run `resolvroom pair` on the other machine.
```

## Mode rules during onboarding

- The mode is always decided by the machine that **receives** requests.
- A new peer starts at `ask`, read-only. Raising it is a separate, deliberate step: `resolvroom peer set notebook-a --mode auto --scope <folder> --expires 8h`.
- A session can only lower the mode, never raise it.

## Failure cases

| Situation | What the user sees |
|---|---|
| Tailscale not installed or logged out | `doctor` stops with the exact fix and a link to the Tailscale install page |
| Tag missing or not applied yet | The wizard waits and re-checks; it never continues silently |
| Pair code expired or wrong 3 times | The pairing window closes; run `resolvroom pair` again |
| Peer offline during `consult` | Immediate "peer unavailable"; no session is created |
| Agent not installed on the peer | `session.reject` with `agent_unavailable` and a readable message |
