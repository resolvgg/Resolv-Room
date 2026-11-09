import { describe, expect, it } from "vitest";
import { PeerUnavailableError, IdentityMismatchError, UnknownSessionError } from "../src/index.js";
import { PROTOCOL_VERSION } from "@resolvroom/protocol";
import type { Envelope } from "@resolvroom/protocol";
import { Network, allow, profile } from "./helpers.js";

function setup(guestPeers: ReturnType<typeof allow>[] = [allow("alpha")]) {
  const net = new Network();
  const a = net.add("alpha");
  const b = net.add("beta", { peers: guestPeers });
  return { net, a, b };
}

const ask = (a: ReturnType<typeof setup>["a"]) =>
  a.engine.consult({ peer: "beta", goal: "fix the bug", proposal: "I think it is the cache" });

describe("consult: happy path", () => {
  it("ask mode: asks the local human, runs the agent, returns the answer", async () => {
    const { a, b } = setup();
    const out = await ask(a);
    expect(out.status).toBe("solved");
    expect(out.summary).toBe("answer to: I think it is the cache");
    expect(out.effective?.mode).toBe("ask");
    expect(b.prompter.requests).toHaveLength(1);
    expect(b.prompter.requests[0]?.goal).toBe("fix the bug");
    expect(b.prompter.requests[0]?.proposal).toContain("cache");
    expect(b.runner.calls).toHaveLength(1);
    expect(b.runner.calls[0]?.goal).toBe("fix the bug");
  });

  it("host log has stamped, strictly increasing seq and both directions", async () => {
    const { a } = setup();
    const out = await ask(a);
    const rows = a.logs.sessions.get(out.sessionId) ?? [];
    const types = rows.map((r) => r.envelope.type);
    const core = types.filter((t) => t !== "session.status");
    expect(core).toEqual(["session.open", "session.accept", "message", "result", "session.close"]);
    expect(rows.map((r) => r.dir).slice(0, 3)).toEqual(["out", "in", "out"]);
    const seqs = rows.map((r) => r.envelope.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(rows[0]?.envelope.type).toBe("session.open");
    expect(rows.at(-1)?.envelope.type).toBe("session.close");
  });

  it("guest keeps permission decisions locally", async () => {
    const { a, b } = setup();
    await ask(a);
    const events = b.logs.decisions.map((d) => d.event);
    expect(events).toEqual(["accept", "ask"]);
    expect(a.logs.decisions).toHaveLength(0);
  });
});

describe("consult: refusals", () => {
  it("peer not on the allowlist -> rejected not_allowed", async () => {
    const { a, b } = setup([]);
    const out = await ask(a);
    expect(out.status).toBe("rejected");
    expect(out.rejectReason).toBe("not_allowed");
    expect(b.runner.calls).toHaveLength(0);
  });

  it("peer offline -> PeerUnavailableError and no session", async () => {
    const { net, a } = setup();
    net.down.add("beta");
    await expect(ask(a)).rejects.toBeInstanceOf(PeerUnavailableError);
    expect(a.logs.sessions.size).toBe(0);
  });

  it("human denies -> declined, agent never runs", async () => {
    const { a, b } = setup();
    b.prompter.answer = "deny";
    const out = await ask(a);
    expect(out.status).toBe("declined");
    expect(b.runner.calls).toHaveLength(0);
    expect(b.engine.activeGuestSessions).toBe(0);
  });

  it("human never answers -> deny after ask.timeout_s", async () => {
    const { a, b } = setup([allow("alpha", profile({ ask: { timeout_s: 1 } }))]);
    b.prompter.answer = "never";
    const out = await ask(a);
    expect(out.status).toBe("declined");
    expect(b.runner.calls).toHaveLength(0);
  }, 10000);

  it("runner not available -> rejected agent_unavailable", async () => {
    const { a, b } = setup();
    b.runner.isAvailable = false;
    const out = await ask(a);
    expect(out.rejectReason).toBe("agent_unavailable");
  });

  it("runner cannot honor the permissions -> rejected agent_unavailable", async () => {
    const { a, b } = setup();
    b.runner.restrictTo = () => null;
    const out = await ask(a);
    expect(out.rejectReason).toBe("agent_unavailable");
    expect(b.runner.calls).toHaveLength(0);
  });

  it("busy when too many sessions run", async () => {
    const net = new Network();
    const a = net.add("alpha");
    const b = net.add("beta", { peers: [allow("alpha")] }, { maxConcurrentGuest: 1 });
    let release!: () => void;
    b.runner.impl = () => new Promise((r) => (release = () => r({ status: "solved", summary: "ok" })));
    const first = a.engine.consult({ peer: "beta", goal: "g", proposal: "p1" });
    await vi_waitFor(() => b.runner.calls.length === 1);
    const second = await a.engine.consult({ peer: "beta", goal: "g", proposal: "p2" });
    expect(second.rejectReason).toBe("busy");
    release();
    expect((await first).status).toBe("solved");
  });

  it("room sessions are refused by this build", async () => {
    const { b } = setup();
    const open: Envelope = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      type: "session.open",
      from: { peer: "alpha" },
      to: { peer: "beta" },
      ts: new Date().toISOString(),
      payload: { kind: "room", goal: "x", participants: [{ peer: "alpha" }, { peer: "beta" }] },
    };
    await b.engine.receive(open, { peer: "alpha", tags: [] });
    await vi_waitFor(() => b.logs.sessions.get(open.session_id)?.some((r) => r.dir === "out") ?? false);
    const out = b.logs.sessions.get(open.session_id)?.find((r) => r.dir === "out")?.envelope;
    expect(out?.type).toBe("session.reject");
  });
});

describe("permissions in a session", () => {
  it("auto profile is downgraded to ask without the auto tag", async () => {
    const auto = profile({
      mode: "auto",
      capabilities: { read: true, write: false, exec: false, network: false },
      scope: { roots: ["/tmp/x"] },
      expires_at: null,
    });
    const { net, a, b } = setup([allow("alpha", auto)]);
    b.config.ceiling = "auto";
    const out = await ask(a);
    expect(out.effective?.mode).toBe("ask");
    expect(b.prompter.requests).toHaveLength(1);
    net.tags.set("alpha", ["tag:resolvroom-auto"]);
    const out2 = await ask(a);
    expect(out2.effective?.mode).toBe("auto");
    expect(b.prompter.requests).toHaveLength(1); // no new prompt in auto
  });

  it("mode_cap ask forces a prompt even for a granted auto", async () => {
    const auto = profile({ mode: "auto", scope: { roots: ["/tmp/x"] }, expires_at: null });
    const { net, a, b } = setup([allow("alpha", auto)]);
    b.config.ceiling = "auto";
    net.tags.set("alpha", ["tag:resolvroom-auto"]);
    const out = await a.engine.consult({ peer: "beta", goal: "g", proposal: "p", modeCap: "ask" });
    expect(out.effective?.mode).toBe("ask");
    expect(b.prompter.requests).toHaveLength(1);
  });

  it("the runner receives the capabilities it can honor, and accept advertises them", async () => {
    const { a, b } = setup([allow("alpha", profile({ capabilities: { read: true, write: true, exec: true, network: false } }))]);
    b.runner.restrictTo = (p) => ({ ...p.capabilities, exec: false });
    const out = await ask(a);
    expect(out.effective?.capabilities.exec).toBe(false);
    expect(b.runner.calls[0]?.permissions.capabilities.exec).toBe(false);
  });
});

describe("limits", () => {
  it("idle timeout when the guest goes silent (no heartbeats)", async () => {
    const net = new Network();
    const a = net.add("alpha");
    const b = net.add("beta", { peers: [allow("alpha")] }, { heartbeatMs: 100000 });
    b.runner.impl = () => new Promise(() => undefined);
    const out = await a.engine.consult({ peer: "beta", goal: "g", proposal: "p", limits: { idle_timeout_s: 1, max_duration_s: 30 } });
    expect(out.status).toBe("timeout");
    expect(out.summary).toContain("idle");
  }, 15000);

  it("duration limit ends a long run and aborts the agent", async () => {
    const { a, b } = setup();
    let aborted = false;
    b.runner.impl = (req) =>
      new Promise((_, reject) => {
        req.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const out = await a.engine.consult({ peer: "beta", goal: "g", proposal: "p", limits: { max_duration_s: 1, idle_timeout_s: 30 } });
    expect(out.status).toBe("timeout");
    expect(out.summary).toContain("maximum session duration");
    await vi_waitFor(() => aborted);
  }, 15000);

  it("cancel via AbortSignal", async () => {
    const { a, b } = setup();
    b.runner.impl = () => new Promise(() => undefined);
    const ctl = new AbortController();
    const p = a.engine.consult({ peer: "beta", goal: "g", proposal: "p", signal: ctl.signal });
    await vi_waitFor(() => b.runner.calls.length === 1);
    ctl.abort();
    expect((await p).status).toBe("cancelled");
    await vi_waitFor(() => b.engine.activeGuestSessions === 0);
  });

  it("agent failure is reported as failed", async () => {
    const { a, b } = setup();
    b.runner.impl = async () => {
      throw new Error("boom");
    };
    const out = await ask(a);
    expect(out.status).toBe("failed");
    expect(out.summary).toContain("agent_failed");
    expect(out.summary).toContain("boom");
  });
});

describe("identity and idempotency", () => {
  it("rejects an envelope whose from.peer differs from the verified identity", async () => {
    const { b } = setup();
    const env: Envelope = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      type: "session.open",
      from: { peer: "alpha" },
      to: { peer: "beta" },
      ts: new Date().toISOString(),
      payload: { kind: "consult", goal: "g" },
    };
    await expect(b.engine.receive(env, { peer: "mallory", tags: [] })).rejects.toBeInstanceOf(IdentityMismatchError);
  });

  it("unknown session -> UnknownSessionError", async () => {
    const { b } = setup();
    const env: Envelope = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      type: "message",
      from: { peer: "alpha" },
      to: { peer: "beta" },
      ts: new Date().toISOString(),
      payload: { text: "hi" },
    };
    await expect(b.engine.receive(env, { peer: "alpha", tags: [] })).rejects.toBeInstanceOf(UnknownSessionError);
  });

  it("a duplicate envelope id is ignored", async () => {
    const { b } = setup();
    const env: Envelope = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      type: "session.open",
      from: { peer: "alpha" },
      to: { peer: "beta" },
      ts: new Date().toISOString(),
      payload: { kind: "consult", goal: "g" },
    };
    await b.engine.receive(env, { peer: "alpha", tags: [] });
    await b.engine.receive(env, { peer: "alpha", tags: [] });
    await vi_waitFor(() => b.engine.activeGuestSessions === 1);
    expect(b.logs.decisions.filter((d) => d.event === "accept")).toHaveLength(1);
  });

  it("another peer cannot hijack a session", async () => {
    const { net, a, b } = setup();
    net.add("mallory", { peers: [] });
    b.runner.impl = () => new Promise(() => undefined);
    const ctl = new AbortController();
    const p = a.engine.consult({ peer: "beta", goal: "g", proposal: "p", signal: ctl.signal });
    await vi_waitFor(() => b.runner.calls.length === 1);
    const sid = b.runner.calls[0]?.sessionId as string;
    const env: Envelope = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      session_id: sid,
      type: "session.close",
      from: { peer: "mallory" },
      to: { peer: "beta" },
      ts: new Date().toISOString(),
      payload: { reason: "cancelled" },
    };
    await expect(b.engine.receive(env, { peer: "mallory", tags: [] })).rejects.toBeInstanceOf(IdentityMismatchError);
    ctl.abort();
    await p;
  });
});

async function vi_waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
