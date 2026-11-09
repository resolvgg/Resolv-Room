# Resolv Room specification

Version **0.1** (draft). The spec is independent of any implementation: a daemon written in any language is compatible if it follows these documents and validates against the JSON Schemas.

| Document | What it covers |
|---|---|
| [`protocol-v0.1.md`](protocol-v0.1.md) | Identity, transport binding, the envelope, message types, session lifecycle for `consult` and `room`, limits |
| [`permissions-v0.1.md`](permissions-v0.1.md) | `ask` and `auto` modes, permission profiles, tailnet tags, the hard deny list, how a decision is made |
| [`../docs/onboarding.md`](../docs/onboarding.md) | First-install flow: `init`, tags, MCP registration, pairing, test consult |
| [`schemas/`](schemas/) | JSON Schema (2020-12) for the envelope, permission profile and daemon config |
| [`examples/`](examples/) | Valid examples. Every file is validated by the test suite in `packages/protocol` |

The words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Versioning

`v` is `major.minor`. A peer that receives an envelope with a version it does not support answers with `session.reject` (`unsupported_version`) or an `error` envelope. Within a major version, new fields are added only as optional ones; schemas use `additionalProperties: false`, so a new field also means a new minor version.
