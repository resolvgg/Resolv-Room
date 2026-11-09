import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@resolvroom/protocol";
import type { PermissionProfile } from "@resolvroom/protocol";
import type { ApprovalRequest, Prompter } from "@resolvroom/core";
import { MockRunner } from "@resolvroom/runner";
import { ControlClient, ControlError, DEV_PEER_HEADER, DEV_TAGS_HEADER, startDaemon } from "../src/index.js";
import type { DaemonHandle } from "../src/index.js";

class RecordingPrompter implements Prompter {
  requests: ApprovalRequest[] = [];
  answer: "allow" | "deny" = "allow";
  async approve(r: ApprovalRequest): Promise<"allow" | "deny"> {
    this.requests.push(r);
    return this.answer;
  }
}

const READ_ONLY = { read: true, write: false, exec: false, network: false };
const ASK: PermissionProfile = { mode: "ask", capabilities: READ_ONLY };
const tmp = () => mkdtempSync(join(tmpdir(), "rr-d-"));

const open: DaemonHandle[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function pair(opts: { allowAlpha?: boolean; devTags?: string[] } = {}) {
  const pa = new RecordingPrompter();
  const pb = new RecordingPrompter();
  const mk = async (name: string, prompter: Prompter, devTags: string[] = []) => {
    const d = await startDaemon({
      home: tmp(),
      name,
      bind: "127.0.0.1",
      port: 0,
      identity: "dev",
      devTags,
      runner: new MockRunner({ name, delayMs: 20 }),
      prompter,
      heartbeatMs: 50,
      onError: () => undefined,
    });
    open.push(d);
    return d;
  };
  const alpha = await mk("alpha", pa, opts.devTags ?? []);
  const beta = await mk("beta", pb);
  alpha.store.upsertPeer("beta", ASK, `http://127.0.0.1:${beta.port}`);
  // beta needs alpha's endpoint to send replies; it only accepts alpha if allowAlpha
  if (opts.allowAlpha === false) {
    beta.store.save({ v: PROTOCOL_VERSION, peers: [{ peer: "alpha-endpoint-only", profile: ASK, added_at: new Date().toISOString(), endpoint: `http://127.0.0.1:${alpha.port}` }] });
  } else {
    beta.store.upsertPeer("alpha", ASK, `http://127.0.0.1:${alpha.port}`);
  }
  return { alpha, beta, pa, pb, ctl: new ControlClient(alpha.store.socketPath) };
}

describe("two daemons over real HTTP", () => {
  it("consult end to end through the control socket", async () => {
    const { alpha, beta, pb, ctl } = await pair();
    const out = await ctl.consult({ peer: "beta", goal: "fix the cache bug", proposal: "evict on write" });
    expect(out.status).toBe("solved");
    expect(out.summary).toContain("[mock agent on beta]");
    expect(out.summary).toContain("evict on write");
    expect(out.effective).toEqual({ mode: "ask", capabilities: { ...READ_ONLY } });
    expect(pb.requests).toHaveLength(1);
    expect(pb.requests[0]?.peer).toBe("alpha");

    const hostFiles = readdirSync(join(alpha.store.logDir, "sessions"));
    const guestFiles = readdirSync(join(beta.store.logDir, "sessions"));
    expect(hostFiles).toEqual([`${out.sessionId}.jsonl`]);
    expect(guestFiles).toEqual([`${out.sessionId}.jsonl`]);
    expect(existsSync(join(beta.store.logDir, "decisions.jsonl"))).toBe(true);
    expect(existsSync(join(alpha.store.logDir, "decisions.jsonl"))).toBe(false);
    const lines = readFileSync(join(alpha.store.logDir, "sessions", hostFiles[0] as string), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });

  it("not on the peer's allowlist -> rejected", async () => {
    const { ctl } = await pair({ allowAlpha: false });
    const out = await ctl.consult({ peer: "beta", goal: "g", proposal: "p" });
    expect(out.status).toBe("rejected");
    expect(out.rejectReason).toBe("not_allowed");
  });

  it("the human on the peer says no -> declined", async () => {
    const { ctl, pb } = await pair();
    pb.answer = "deny";
    const out = await ctl.consult({ peer: "beta", goal: "g", proposal: "p" });
    expect(out.status).toBe("declined");
  });

  it("peer offline -> peer_unavailable and no session", async () => {
    const { ctl, beta } = await pair();
    await beta.close();
    open.splice(open.indexOf(beta), 1);
    await expect(ctl.consult({ peer: "beta", goal: "g", proposal: "p" })).rejects.toMatchObject({ code: "peer_unavailable" });
  });

  it("validates control requests", async () => {
    const { ctl } = await pair();
    await expect(ctl.consult({ peer: "beta", goal: "", proposal: "p" })).rejects.toBeInstanceOf(ControlError);
    await expect(ctl.consult({ peer: "beta", goal: "g", proposal: "p", mode_cap: "auto" as never })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("status and peers", async () => {
    const { ctl } = await pair();
    expect((await ctl.status()).name).toBe("alpha");
    const peers = await ctl.peers();
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ peer: "beta", mode: "ask" });
  });

  it("control socket is 0600 and a second daemon on the same home is refused", async () => {
    const { alpha } = await pair();
    expect(statSync(alpha.store.socketPath).mode & 0o777).toBe(0o600);
    await expect(
      startDaemon({ home: alpha.store.home, name: "x", bind: "127.0.0.1", port: 0, identity: "dev", runner: new MockRunner({ name: "x" }), prompter: new RecordingPrompter() }),
    ).rejects.toThrow(/already running/);
  });

  it("daemon-not-running is reported clearly", async () => {
    const c = new ControlClient(join(tmp(), "nope.sock"));
    await expect(c.status()).rejects.toMatchObject({ code: "daemon_not_running" });
  });
});

describe("transport hardening", () => {
  const env = (over: Record<string, unknown> = {}) => ({
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    type: "session.open",
    from: { peer: "alpha" },
    to: { peer: "beta" },
    ts: new Date().toISOString(),
    payload: { kind: "consult", goal: "g" },
    ...over,
  });
  const post = (d: DaemonHandle, body: unknown, headers: Record<string, string> = { [DEV_PEER_HEADER]: "alpha" }) =>
    fetch(`http://127.0.0.1:${d.port}/v1/envelopes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("no verified identity -> 403 on everything", async () => {
    const { beta } = await pair();
    expect((await post(beta, env(), {})).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${beta.port}/v1/ping`)).status).toBe(403);
  });

  it("from.peer different from the verified identity -> 403", async () => {
    const { beta } = await pair();
    const res = await post(beta, env({ from: { peer: "mallory" } }));
    expect(res.status).toBe(403);
  });

  it("invalid JSON and invalid envelopes -> 400", async () => {
    const { beta } = await pair();
    expect((await post(beta, "{nope")).status).toBe(400);
    const res = await post(beta, env({ type: "bogus" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("protocol_violation");
  });

  it("unknown session -> 404, oversized body -> 413, unknown endpoint -> 404", async () => {
    const { beta } = await pair();
    expect((await post(beta, env({ type: "message", payload: { text: "hi" } }))).status).toBe(404);
    expect((await post(beta, "x".repeat(1024 * 1024 + 10))).status).toBe(413);
    const res = await fetch(`http://127.0.0.1:${beta.port}/nope`, { headers: { [DEV_PEER_HEADER]: "alpha" } });
    expect(res.status).toBe(404);
  });

  it("ping works with an identity and reports protocol and agents", async () => {
    const { beta } = await pair();
    const res = await fetch(`http://127.0.0.1:${beta.port}/v1/ping`, { headers: { [DEV_PEER_HEADER]: "alpha", [DEV_TAGS_HEADER]: "" } });
    expect(await res.json()).toEqual({ v: "0.1", peer: "beta", agents: ["claude-code"] });
  });

  it("never listens on all interfaces; dev identity only on loopback", async () => {
    const base = { home: tmp(), name: "x", port: 0, runner: new MockRunner({ name: "x" }), prompter: new RecordingPrompter() };
    await expect(startDaemon({ ...base, bind: "0.0.0.0", identity: "tailscale" })).rejects.toThrow(/all interfaces/);
    await expect(startDaemon({ ...base, bind: "192.0.2.1", identity: "dev" })).rejects.toThrow(/loopback/);
  });

  it("dev tags simulate tailscale tags (auto needs the auto tag)", async () => {
    const { alpha, beta, ctl } = await pair({ devTags: ["tag:resolvroom-auto"] });
    const root = tmp();
    beta.store.upsertPeer(
      "alpha",
      { mode: "auto", capabilities: READ_ONLY, scope: { roots: [root] }, expires_at: null },
      `http://127.0.0.1:${alpha.port}`,
    );
    const cfg = beta.store.load();
    cfg.ceiling = "auto";
    beta.store.save(cfg);
    const out = await ctl.consult({ peer: "beta", goal: "g", proposal: "p" });
    expect(out.effective?.mode).toBe("auto");
    const out2 = await ctl.consult({ peer: "beta", goal: "g", proposal: "p", mode_cap: "ask" });
    expect(out2.effective?.mode).toBe("ask");
  });
});
