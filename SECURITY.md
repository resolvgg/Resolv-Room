# Security policy

Resolv Room lets one agent act on another machine, so security is the core of the design. Please report problems privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Please do not open a public issue for security problems.

Include what you found, how to reproduce it, and which version or commit you tested. We will acknowledge the report and keep you updated until it is fixed.

## Supported versions

The project is pre-alpha and has no released versions yet. Only the `main` branch is considered.

## Threat model in short

The main risks the design addresses (see [`spec/permissions-v0.1.md`](spec/permissions-v0.1.md) for the full rules):

- A peer trying to make the local agent do more than the local owner allowed (permissions are decided by the receiver, a session can only lower them).
- An agent reading credentials or editing the daemon's own config (hard deny list, not overridable).
- A request that is really prompt injection arriving through another agent's text (read-only and `ask` are the defaults; `auto` requires an explicit scope and an expiry).
- A node on the network pretending to be a known peer (identity is checked against Tailscale, not claimed in the message).
- Runaway loops and cost (limits on rounds, time and inactivity are on by default).
