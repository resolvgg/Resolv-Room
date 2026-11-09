# Resolv Room protocol v0.1

Status: draft.

## 1. Terms

- **Peer**: a machine running a Resolv Room daemon. Its name is its Tailscale node name.
- **Agent**: an AI agent on a peer (for example `claude-code`, `openclaw`, `hermes`). The daemon starts it through a runner.
- **Session**: one unit of collaboration with its own `session_id`, log and limits. Kinds: `consult` and `room`.
- **Host**: the peer that opened the session. It keeps the log, enforces limits and moderates turns. There is no fixed host: whoever opens a session hosts it.
- **Participant**: a peer/agent taking part in a session. The host is also a participant.
- **Round**: one completed turn, meaning one `message`, `question`, `handoff` or `result` posted by the participant that held the turn.

## 2. Identity

Identity is never claimed in a message; it is verified from the network.

1. The receiving daemon takes the source address of the connection and asks the local Tailscale which node it is (`tailscale whois`), obtaining the node name and its tags.
2. `from.peer` in every envelope MUST equal that node name. A mismatch is rejected with HTTP 403.
3. The node name MUST be on the receiver's allowlist (`peers` in the daemon config). A `session.open` from a node that is not listed is refused with HTTP `403` and the error code `not_allowed`, and the receiver sends nothing back, so a stranger cannot make the daemon open connections. The host treats this as a rejection with reason `not_allowed`. Having the right Tailscale tag is necessary but not enough.
4. The tags returned by whois feed the permission rules in [`permissions-v0.1.md`](permissions-v0.1.md).

## 3. Transport binding

Each daemon listens only on the Tailscale interface of its machine (never `0.0.0.0`), default port `7777`, HTTP/1.1 with JSON bodies. WireGuard in the tailnet provides the encryption.

| Endpoint | Purpose |
|---|---|
| `GET /v1/ping` | Liveness and capability probe. Returns `{ "v": "0.1", "peer": "<name>", "agents": ["claude-code", ...] }`. A host MUST call it before opening a session. If the peer does not answer, the session is not created and the caller gets a clear "peer unavailable" error. |
| `POST /v1/envelopes` | Delivers one envelope (body is the envelope). `202` when accepted. Refusals are `4xx` with the body `{ "error": { "code": "...", "message": "..." } }`: `400` invalid envelope (`protocol_violation`), `403` identity mismatch (`permission_denied`) or not on the allowlist (`not_allowed`), `404` unknown session, `413` body over 1 MiB. |

Where to reach a peer: `peers[].endpoint` in the config, otherwise `http://<peer>:7777` (MagicDNS). Pairing endpoints are not specified yet (see `docs/onboarding.md`).

## 4. Envelope

Schema: [`schemas/envelope.schema.json`](schemas/envelope.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `v` | yes | Protocol version, `"0.1"` |
| `id` | yes | UUID of this envelope. Receivers MUST ignore an `id` they have already processed |
| `session_id` | yes | UUID of the session |
| `seq` | no | Position in the session log. Stamped by the host; absent on envelopes sent to the host |
| `in_reply_to` | no | `id` of the envelope this answers |
| `type` | yes | See section 5 |
| `from` | yes | `{ peer, agent? }` |
| `to` | yes | `{ peer, agent? }` or `"all"` |
| `ts` | yes | RFC 3339 timestamp |
| `payload` | yes | Depends on `type` |

The agent name `human` is reserved for messages the host's operator injects into a session.

## 5. Message types

| `type` | Direction | Payload | Meaning |
|---|---|---|---|
| `session.open` | host → participants | `kind`, `goal`, `participants?`, `limits?`, `mode_cap?` | Invitation. `mode_cap` can only lower the mode the receiver applies |
| `session.accept` | participant → host | `effective: { mode, capabilities }` | Accepts and discloses the mode and capabilities that will really apply, after the runner reduced them to what it can enforce. Folder paths are never disclosed |
| `session.reject` | participant → host | `reason`, `detail?` | Refuses. Reasons: `not_allowed`, `busy`, `unsupported_version`, `limits_unacceptable`, `user_declined`, `agent_unavailable` |
| `session.status` | participant → host | `state` | `working`, `awaiting_approval`, `awaiting_human`, `idle`. Carries no detail on purpose: what is being asked stays on the receiving machine |
| `message` | any | `text`, `format?` | Content |
| `question` | any | `text`, `format?` | A question addressed to `to` |
| `handoff` | any | `text`, `format?` | Passes the turn to `to` |
| `result` | participant → host | `status`, `summary`, `format?` | Proposed outcome. `status`: `solved`, `partial`, `unsolved` |
| `error` | any | `code`, `message` | Codes: `protocol_violation`, `unsupported_version`, `limit_exceeded`, `permission_denied`, `agent_failed`, `internal` |
| `session.close` | host → all | `reason`, `summary?` | Ends the session. Reasons: `done`, `cancelled`, `error`, `limit_reached`, `peer_unavailable`, `rejected` |

## 6. Session lifecycle

### 6.1 Consult

One proposal, one answer. Used when an agent has already worked on a problem and wants a second opinion.

1. The host calls `GET /v1/ping` on the target. If it fails, no session is created.
2. Host → target: `session.open` (`kind: "consult"`).
3. Target resolves permissions (section 3 of the permissions spec) and answers `session.accept` or `session.reject`.
4. Host → target: `message` carrying the proposal.
5. The target runs its agent through a runner under the effective permissions. While it works it MAY send `session.status`.
6. Target → host: `result`.
7. Host → target: `session.close` (`done`).

In `ask` mode the target asks its local human when the proposal (step 4) arrives, so the prompt can show it; it reports `session.status` `awaiting_approval` meanwhile. If the human says no (or does not answer within `ask.timeout_s`) the target sends `error` with `permission_denied` and the host reports the consult as declined. In this version the approval is **per session**, not per action.

Default limits: `max_rounds` 1, `max_duration_s` 300, `idle_timeout_s` 120. The target gets exactly one turn. If it needs clarification it says so in the `result` and the host may open a room.

### 6.2 Room

Several rounds between two or more agents, moderated by the host.

1. Host → every participant: `session.open` (`kind: "room"`, `participants`, `limits`).
2. Every participant answers `session.accept` or `session.reject`. The room starts only when all accepted; otherwise the host closes it with `rejected`.
3. **Turns.** A participant MUST post only while it holds the turn: after it received an envelope addressed to it (or to `all`) and until it replies. The host answers an out-of-turn envelope with `error` (`protocol_violation`) and does not relay it.
4. **Default moderator (`rules`).** After a `question` or `handoff` the turn goes to the addressee. After a `message` the turn goes to the next participant in the order of `participants`. The host relays every accepted envelope to the other participants, stamping `seq`.
5. **Finishing.** A `result` is a proposed outcome. The host gives every other participant one turn to confirm it with a `result` of its own, or to object with a `message` or `question`. If all confirm, the host closes the room with `done`; if anyone objects, the room continues.
6. Other moderator strategies are expected to be pluggable in later versions. v0.1 specifies only `rules`.

Default limits: `max_rounds` 12, `max_duration_s` 900, `idle_timeout_s` 120.

## 7. Limits and enforcement

Limits are enforced by the host and are on by default.

- **Rounds**: when `max_rounds` is reached the host sends `session.close` with `limit_reached` and the last known state as `summary`.
- **Duration**: same, measured from `session.open`.
- **Inactivity**: if the participant holding the turn sends nothing for `idle_timeout_s`, the host closes the session with `peer_unavailable`. While a participant reports `awaiting_approval` or `awaiting_human` the inactivity timer is paused, but the duration limit keeps running. The wait for a local approval is itself bounded by `ask.timeout_s` in the receiver's profile.
- **Tokens**: `max_tokens` is advisory and enforced only when the runner can measure usage.
- **Loops**: the host SHOULD close a session when one participant posts the same text three times in a row, and SHOULD surface it to its operator.
- **Operator**: the host's operator can inject a message (as agent `human`), pause, or cancel at any time. Cancelling sends `session.close` with `cancelled`.

## 8. Ordering, idempotency and logs

- The host stamps a strictly increasing `seq` starting at 0 and relays in `seq` order.
- Receivers MUST ignore an envelope whose `id` they already processed.
- The host appends every envelope of the session to an append-only JSON Lines log. Each peer also keeps its own local log, which includes its permission decisions; those decisions are never transmitted.

## 9. Errors

An envelope that fails schema validation is refused with HTTP `400` and an `error` envelope (`protocol_violation`). An unsupported `v` is refused with `unsupported_version`. A runner failure is reported as `error` (`agent_failed`) and the host decides whether to continue or close.
