# Permissions v0.1

Status: draft. Schemas: [`schemas/permission-profile.schema.json`](schemas/permission-profile.schema.json) and [`schemas/config.schema.json`](schemas/config.schema.json). Reference implementation: `packages/protocol/src/permissions.ts`.

## 1. Principles

1. **The receiver decides.** The machine where an action would happen decides what is allowed there. A requester never sends or raises its own permissions.
2. **A session can only lower, never raise.** `mode_cap` in `session.open` can force `ask`; nothing can force `auto`.
3. **Safe by default.** The default is `ask`, read-only, with no folder pre-approved.
4. **Hard deny first.** Some paths and kinds of action can never be allowed, whatever the profile or the human answers at a prompt.
5. **Everything is logged locally.** Every decision, prompt and answer is written to the receiver's local log and is not sent to the host.

## 2. Modes

| | `ask` | `auto` |
|---|---|---|
| Meaning | Before an action, the local human is asked | Actions inside the granted scope run without asking |
| Default | yes | no, it needs an explicit opt-in per peer |
| Scope | `roots` are ignored: every access prompts | `roots` are required: the folders that can be used without prompting |
| Expiry | n/a | `expires_at` is required; `null` (no expiry) must be written explicitly |
| Outside the scope | n/a | `out_of_scope`: `ask` (default) or `deny` |

## 3. Capabilities

`capabilities` says which kinds of action may happen at all: `read`, `write`, `exec`, `network`. Mode decides whether a permitted action prompts. A disabled capability is denied without a prompt in both modes. The default profile is read-only: `read: true`, everything else `false`.

## 4. Permission profile

One profile per allowlisted peer, stored in the receiver's config (`peers[].profile`). See the schema. Notable fields:

- `scope.roots`: absolute folders used by `auto` mode.
- `scope.extra_deny`: extra glob patterns that are always denied, on top of the hard deny list.
- `ask.timeout_s` (default 120): how long a prompt waits. No answer means deny.
- `ask.remember`: `never` (default) or `session`. "Allow for this session" is remembered until the session closes and never longer.

## 5. Tags

Tags are Tailscale node tags, set by the tailnet admin. They are labels on the machine; they never grant anything alone.

| Tag | Meaning | Effect |
|---|---|---|
| `tag:resolvroom` | The node runs Resolv Room | Lets the node reach the daemon port through the tailnet ACL. Does not authorize anything by itself: the peer must also be on the allowlist |
| `tag:resolvroom-ask` | Force ask | The node is always handled in `ask` mode, even if its profile says `auto` |
| `tag:resolvroom-auto` | Eligible for auto | With `auto_requires_tag: true` (default), a peer can run in `auto` only if its node carries this tag. The local owner still has to grant `auto` in the profile |

If a node carries both `-ask` and `-auto`, `ask` wins.

This gives two independent layers for `auto`: the tailnet admin must mark the machine as eligible, and the local owner must grant the mode, with a folder scope and an expiry.

Example tailnet policy (check the current Tailscale documentation for exact syntax):

```json
{
  "tagOwners": {
    "tag:resolvroom": ["autogroup:admin"],
    "tag:resolvroom-ask": ["autogroup:admin"],
    "tag:resolvroom-auto": ["autogroup:admin"]
  },
  "acls": [
    { "action": "accept", "src": ["tag:resolvroom"], "dst": ["tag:resolvroom:7777"] }
  ]
}
```

## 6. Resolving the mode for a session

When a `session.open` arrives, the receiver computes the effective permissions:

1. No allowlist entry for the peer: refuse with `session.reject` (`not_allowed`).
2. Start from the profile's mode and capabilities.
3. If the profile mode is `auto`, it is downgraded to `ask` when **any** of these holds. Every reason is recorded:
   - `ceiling`: the machine's `ceiling` is not `auto` (default `ask`);
   - `session_cap`: the session asked for `mode_cap: "ask"`;
   - `tag_ask`: the node has `tag:resolvroom-ask`;
   - `missing_auto_tag`: `auto_requires_tag` is true and the node lacks `tag:resolvroom-auto`;
   - `expired`: `expires_at` has passed.
4. A downgraded `auto` profile runs as plain `ask`: its `roots` do not pre-approve anything.
5. The receiver answers `session.accept` with the effective `mode` and `capabilities` (never the paths).

The reference implementation is `resolvePermissions()`.

## 7. Deciding one action

For each action (`read`, `write`, `exec` with a working directory, or `network`) the receiver decides, in this order:

1. Capability disabled: **deny**.
2. Path is not absolute: **deny**. Implementations MUST resolve symlinks and `..` before deciding.
3. Path matches the hard deny list: **deny**.
4. Path matches `scope.extra_deny`: **deny**.
5. Mode `ask`: **ask** the local human.
6. Mode `auto`:
   - `network` with the capability enabled: **allow**;
   - no path available: **ask**;
   - path inside one of the `roots`: **allow**;
   - otherwise `out_of_scope` decides: **ask** (default) or **deny**.

A deny is final: answering "allow" at a prompt cannot override steps 1 to 4. The reference implementation is `decideAction()`.

## 8. Hard deny list

Not overridable by any profile. Matched case-insensitively against the resolved absolute path. For the receiver's home folder `~`:

- `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.config/gcloud`, `~/.config/gh`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`
- password stores and keyrings: `~/.password-store`, `~/.local/share/keyrings`, `~/Library/Keychains`
- browser profiles: `~/.mozilla`, `~/.config/google-chrome`, `~/.config/chromium`, `~/Library/Application Support/Google/Chrome`
- **`~/.resolvroom`**: the daemon's own config. An agent that could edit it could grant itself `auto`.
- anywhere: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`

The list is intentionally conservative (it also blocks `.env.example`). Implementations MAY add entries and MUST NOT remove any.

## 9. The `ask` prompt

When a decision is **ask**, the daemon pauses the agent, reports `session.status` with `awaiting_approval` to the host (no details), and shows the local human a prompt with at least: the peer and session, the action, the exact target, and the reason the agent gave. Options:

- allow once;
- allow for this session (only if `ask.remember` is `session`);
- deny;
- deny and close the session.

No answer within `ask.timeout_s` is a deny. The prompt MUST be shown on the receiving machine (terminal or desktop notification); it MUST NOT be answerable by the requester.

## 10. Runners

A runner starts the local agent headless and MUST NOT give it more than the effective permissions:

- map the profile to the agent's own mechanism (read-only mode, tool allowlist, native permission prompts bridged to the `ask` prompt above);
- if the agent cannot be restricted to what the profile allows, the runner MUST refuse the session (`session.reject` with `agent_unavailable`) instead of running it with more power;
- the agent MUST NOT be able to read or write the daemon config (hard deny list).

## 11. Security considerations

- **Prompt injection through the other agent.** Text from a peer is untrusted input to the local agent. That is why `ask` and read-only are the defaults and `auto` needs an explicit scope and expiry.
- **Symlinks and races.** Decisions are made on resolved paths. Implementations SHOULD re-check just before use to narrow time-of-check/time-of-use gaps.
- **Tag trust.** Tags come from the tailnet policy. Anyone who can edit the policy can add `tag:resolvroom-auto`, which is why it only makes a node eligible and a local grant is still required.
- **Secrets in messages.** Agents can put anything in a `message`. The host's log is plain JSON Lines: do not use a room for secrets. Folder paths and prompt contents stay in the receiver's local log.
- **Expiry.** An expired `auto` profile silently behaves as `ask`; it is not deleted, so the owner can renew it.
- **Limits** (rounds, time, inactivity) are independent of the permission mode and always apply.
