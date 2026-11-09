import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { TailscaleIdentityProvider, TerminalPrompter, formatApproval, parseStatusSelf, parseWhois, sanitizeForTerminal } from "../src/index.js";

// Sample shapes follow the documented `tailscale whois --json` / `status --json` output; they have NOT been checked
// against a real tailnet in this sandbox.
const WHOIS = JSON.stringify({
  Node: { Name: "notebook-b.example.ts.net.", ComputedName: "notebook-b", Tags: ["tag:resolvroom", "tag:resolvroom-ask"] },
  UserProfile: { LoginName: "tagged-devices" },
});
const STATUS = JSON.stringify({
  Self: { HostName: "NOTEBOOK-A", DNSName: "notebook-a.example.ts.net.", TailscaleIPs: ["100.64.0.1", "fd7a::1"], Tags: ["tag:resolvroom"] },
});

describe("tailscale parsing", () => {
  it("parseWhois", () => {
    expect(parseWhois(WHOIS)).toEqual({ peer: "notebook-b", tags: ["tag:resolvroom", "tag:resolvroom-ask"] });
    expect(parseWhois(JSON.stringify({ Node: { Name: "x.ts.net." } }))).toEqual({ peer: "x.ts.net", tags: [] });
    expect(parseWhois("not json")).toBeNull();
    expect(parseWhois("{}")).toBeNull();
  });
  it("parseStatusSelf", () => {
    expect(parseStatusSelf(STATUS)).toEqual({ name: "notebook-a", ips: ["100.64.0.1", "fd7a::1"], tags: ["tag:resolvroom"] });
    expect(parseStatusSelf("{}")).toBeNull();
  });
  it("identity provider strips ::ffff:, asks whois and caches", async () => {
    const calls: string[][] = [];
    const p = new TailscaleIdentityProvider(async (_f, args) => {
      calls.push(args);
      return WHOIS;
    });
    const req = { socket: { remoteAddress: "::ffff:100.64.0.2" } } as unknown as IncomingMessage;
    expect(await p.identify(req)).toMatchObject({ peer: "notebook-b" });
    await p.identify(req);
    expect(calls).toEqual([["whois", "--json", "100.64.0.2"]]);
  });
  it("whois failure -> no identity", async () => {
    const p = new TailscaleIdentityProvider(async () => {
      throw new Error("no such peer");
    });
    expect(await p.identify({ socket: { remoteAddress: "100.64.0.9" } } as unknown as IncomingMessage)).toBeNull();
  });
});

describe("terminal safety", () => {
  it("strips ANSI and control characters and truncates", () => {
    const evil = "ok\u001b[2J\u001b[31mred\u001b]0;title\u0007\u0008hidden\u0000";
    const out = sanitizeForTerminal(evil);
    expect(out).not.toMatch(/\u001b/);
    expect(out).not.toContain("\u0000");
    expect(out).toContain("okred");
    expect(sanitizeForTerminal("a".repeat(3000), 100)).toContain("truncated");
  });
  it("formatApproval shows peer, access and the proposal", () => {
    const s = formatApproval({
      peer: "notebook-a", sessionId: "s", goal: "fix\u001b[2J", proposal: "line1\nline2", mode: "ask",
      capabilities: { read: true, write: false, exec: false, network: false }, access: "read files in /p", timeoutS: 120,
      signal: new AbortController().signal,
    });
    expect(s).toContain("notebook-a");
    expect(s).toContain("read files in /p");
    expect(s).toContain("line2");
    expect(s).not.toMatch(/\u001b/);
  });
});

describe("formatApproval for a mid-run access request", () => {
  it("shows the tool and path and what allowing means", () => {
    const base = {
      peer: "laptop", sessionId: "s1", goal: "find the port", proposal: "p", mode: "auto" as const,
      capabilities: { read: true, write: false, exec: false, network: false }, access: "read /x", timeoutS: 60, signal: new AbortController().signal,
    };
    const r = formatApproval({ ...base, action: { tool: "Read", target: "/home/u/other/config.txt\u001b[2J" } });
    expect(r).toContain("outside the shared folder");
    expect(r).toContain("/home/u/other/config.txt");
    expect(r).toContain("read this one file");
    expect(r).not.toMatch(/\u001b/);
    expect(formatApproval({ ...base, action: { tool: "Glob", target: "/home/u/other" } })).toContain("file NAMES");
  });
});

describe("TerminalPrompter", () => {
  const req = (signal: AbortSignal) => ({
    peer: "a", sessionId: "s", goal: "g", proposal: "p", mode: "ask" as const,
    capabilities: { read: true, write: false, exec: false, network: false }, access: "x", timeoutS: 5, signal,
  });
  it("y allows, anything else denies, one prompt at a time", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = new TerminalPrompter({ input, output });
    const first = p.approve(req(new AbortController().signal));
    const second = p.approve(req(new AbortController().signal));
    await new Promise((r) => setTimeout(r, 20));
    input.write("y\n");
    expect(await first).toBe("allow");
    await new Promise((r) => setTimeout(r, 20));
    input.write("\n");
    expect(await second).toBe("deny");
    p.close();
  });
  it("abort (timeout) denies", async () => {
    const p = new TerminalPrompter({ input: new PassThrough(), output: new PassThrough() });
    const ctl = new AbortController();
    const r = p.approve(req(ctl.signal));
    setTimeout(() => ctl.abort(), 20);
    expect(await r).toBe("deny");
    p.close();
  });
});
