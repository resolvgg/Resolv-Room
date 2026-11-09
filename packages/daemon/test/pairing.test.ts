import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "@resolvroom/core";
import { MockRunner } from "@resolvroom/runner";
import { ControlClient, DEFAULT_PAIR_PROFILE, PairingManager, QueuePrompter, generateCode, normalizeCode, startDaemon } from "../src/index.js";
import type { DaemonHandle } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "rr-pair-"));

describe("PairingManager", () => {
  const mk = (over: Partial<ConstructorParameters<typeof PairingManager>[0]> = {}) => {
    let now = 1_000_000;
    const store = new ConfigStore(tmp());
    const m = new PairingManager({ store, requireTag: false, now: () => now, ...over });
    return { m, store, tick: (ms: number) => (now += ms) };
  };
  const id = (peer = "alpha", tags: string[] = []) => ({ peer, tags });

  it("codes look like XXXX-XXXX without confusing characters; normalising is forgiving", () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    expect(normalizeCode("ab12-cd34 ")).toBe("AB12CD34");
  });

  it("right code pairs, adds the peer as ask + read-only, and is single use", () => {
    const { m, store } = mk();
    const { code } = m.start();
    expect(m.verify(id(), code.toLowerCase())).toEqual({ ok: true, peer: "alpha" });
    expect(store.findPeer("alpha")?.profile).toEqual(DEFAULT_PAIR_PROFILE);
    expect(m.status()).toMatchObject({ state: "paired", peer: "alpha" });
    expect(m.verify(id(), code).ok).toBe(false);
  });

  it("three wrong tries lock the window, even for the right code afterwards", () => {
    const { m, store } = mk();
    const { code } = m.start();
    expect(m.verify(id(), "AAAA-AAAA")).toEqual({ ok: false, locked: false });
    expect(m.verify(id(), "AAAA-AAAB")).toEqual({ ok: false, locked: false });
    expect(m.verify(id(), "AAAA-AAAC")).toEqual({ ok: false, locked: true });
    expect(m.verify(id(), code)).toEqual({ ok: false, locked: true });
    expect(m.status().state).toBe("locked");
    expect(store.findPeer("alpha")).toBeUndefined();
  });

  it("expires after the ttl", () => {
    const { m, tick } = mk({ ttlMs: 60_000 });
    const { code } = m.start();
    tick(61_000);
    expect(m.verify(id(), code).ok).toBe(false);
    expect(m.status().state).toBe("expired");
  });

  it("without an open window nothing pairs", () => {
    const { m } = mk();
    expect(m.verify(id(), "ABCD-EFGH").ok).toBe(false);
  });

  it("on a tailnet the caller must carry tag:resolvroom", () => {
    const { m } = mk({ requireTag: true });
    const { code } = m.start();
    expect(m.verify(id("alpha", []), code).ok).toBe(false);
    expect(m.verify(id("alpha", ["tag:resolvroom"]), code).ok).toBe(true);
  });

  it("never changes the profile of a peer that is already allowed", () => {
    const { m, store } = mk();
    store.upsertPeer("alpha", { mode: "ask", capabilities: { read: true, write: true, exec: false, network: false } });
    const { code } = m.start();
    expect(m.verify(id(), code).ok).toBe(true);
    expect(store.findPeer("alpha")?.profile.capabilities.write).toBe(true);
  });

  it("reply endpoint is only trusted in dev mode", () => {
    const a = mk();
    a.m.start();
    const b = mk({ trustReplyEndpoint: true });
    const { code } = b.m.start();
    b.m.verify(id(), code, "http://127.0.0.1:9");
    expect(b.store.findPeer("alpha")?.endpoint).toBe("http://127.0.0.1:9");
    const c = mk();
    const { code: c2 } = c.m.start();
    c.m.verify(id(), c2, "http://127.0.0.1:9");
    expect(c.store.findPeer("alpha")?.endpoint).toBeUndefined();
  });
});

describe("pairing over real HTTP", () => {
  const open: DaemonHandle[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()?.close();
  });
  const mk = async (name: string, approvals?: QueuePrompter) => {
    const d = await startDaemon({
      home: tmp(), name, bind: "127.0.0.1", port: 0, identity: "dev",
      runner: new MockRunner({ name, delayMs: 10 }),
      prompter: approvals ?? { approve: async () => "allow" as const },
      ...(approvals ? { approvals } : {}),
      heartbeatMs: 50, onError: () => undefined,
    });
    open.push(d);
    return d;
  };

  it("B opens a window, A redeems the code: both allow each other and a consult works", async () => {
    const alpha = await mk("alpha");
    const beta = await mk("beta");
    const a = new ControlClient(alpha.store.socketPath);
    const b = new ControlClient(beta.store.socketPath);
    const { code } = await b.pairStart();
    expect((await b.pairStatus()).state).toBe("waiting");
    await a.pairJoin({ peer: "beta", code, endpoint: `http://127.0.0.1:${beta.port}`, reply_endpoint: `http://127.0.0.1:${alpha.port}` });
    expect(await b.pairStatus()).toMatchObject({ state: "paired", peer: "alpha" });
    expect(alpha.store.findPeer("beta")?.profile.mode).toBe("ask");
    expect(beta.store.findPeer("alpha")?.profile.mode).toBe("ask");
    const out = await a.consult({ peer: "beta", goal: "g", proposal: "p" });
    expect(out.status).toBe("solved");
  });

  it("wrong code -> pairing_failed; three wrong -> pairing_locked; nothing is added", async () => {
    const alpha = await mk("alpha");
    const beta = await mk("beta");
    const a = new ControlClient(alpha.store.socketPath);
    const b = new ControlClient(beta.store.socketPath);
    const { code } = await b.pairStart();
    const join = (c: string) => a.pairJoin({ peer: "beta", code: c, endpoint: `http://127.0.0.1:${beta.port}` });
    await expect(join("AAAA-AAAA")).rejects.toMatchObject({ code: "pairing_failed" });
    await expect(join("AAAA-AAAB")).rejects.toMatchObject({ code: "pairing_failed" });
    await expect(join("AAAA-AAAC")).rejects.toMatchObject({ code: "pairing_locked" });
    await expect(join(code)).rejects.toMatchObject({ code: "pairing_locked" });
    expect(beta.store.load().peers).toEqual([]);
    expect(alpha.store.load().peers).toEqual([]);
    expect((await b.pairStatus()).state).toBe("locked");
  });

  it("no window open -> pairing_failed", async () => {
    const alpha = await mk("alpha");
    const beta = await mk("beta");
    await expect(
      new ControlClient(alpha.store.socketPath).pairJoin({ peer: "beta", code: "ABCD-EFGH", endpoint: `http://127.0.0.1:${beta.port}` }),
    ).rejects.toMatchObject({ code: "pairing_failed" });
  });
});

describe("approval queue (daemon without a terminal)", () => {
  it("QueuePrompter: list, answer by short id, abort denies, text is sanitised", async () => {
    const q = new QueuePrompter();
    const ctl = new AbortController();
    const base = { peer: "a\u001b[2J", sessionId: "s", goal: "g", proposal: "p\u0000q", mode: "ask" as const, capabilities: { read: true, write: false, exec: false, network: false }, access: "x", timeoutS: 60 };
    const p1 = q.approve({ ...base, signal: ctl.signal });
    const [item] = q.list();
    expect(item?.peer).toBe("a");
    expect(item?.proposal).toBe("pq");
    expect(q.answer("zzzz", "allow")).toBe("not_found");
    expect(q.answer((item?.id ?? "").slice(0, 3), "allow")).toBe("ok");
    expect(await p1).toBe("allow");
    expect(q.list()).toHaveLength(0);
    const ctl2 = new AbortController();
    const p2 = q.approve({ ...base, signal: ctl2.signal });
    ctl2.abort();
    expect(await p2).toBe("deny");
    expect(q.list()).toHaveLength(0);
  });

  it("a consult waits in the queue until the owner answers through the control socket", async () => {
    const open: DaemonHandle[] = [];
    try {
      const queue = new QueuePrompter();
      const mk = async (name: string, approvals?: QueuePrompter) => {
        const d = await startDaemon({
          home: tmp(), name, bind: "127.0.0.1", port: 0, identity: "dev", runner: new MockRunner({ name, delayMs: 10 }),
          prompter: approvals ?? { approve: async () => "allow" as const }, ...(approvals ? { approvals } : {}), heartbeatMs: 50, onError: () => undefined,
        });
        open.push(d);
        return d;
      };
      const alpha = await mk("alpha");
      const vps = await mk("vps", queue);
      const ro = { mode: "ask" as const, capabilities: { read: true, write: false, exec: false, network: false } };
      alpha.store.upsertPeer("vps", ro, `http://127.0.0.1:${vps.port}`);
      vps.store.upsertPeer("alpha", ro, `http://127.0.0.1:${alpha.port}`);
      const pending = new ControlClient(alpha.store.socketPath).consult({ peer: "vps", goal: "g", proposal: "please review" });
      const owner = new ControlClient(vps.store.socketPath);
      let list = await owner.approvals();
      for (let i = 0; i < 50 && list.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 40));
        list = await owner.approvals();
      }
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ peer: "alpha", goal: "g", proposal: "please review" });
      await owner.answerApproval(list[0]?.id as string, "allow");
      expect((await pending).status).toBe("solved");
      await expect(owner.answerApproval("deadbeef", "allow")).rejects.toMatchObject({ code: "not_found" });

      const second = new ControlClient(alpha.store.socketPath).consult({ peer: "vps", goal: "g2", proposal: "again" });
      let l2 = await owner.approvals();
      for (let i = 0; i < 50 && l2.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 40));
        l2 = await owner.approvals();
      }
      await owner.answerApproval(l2[0]?.id as string, "deny");
      expect((await second).status).toBe("declined");
    } finally {
      while (open.length) await open.pop()?.close();
    }
  });
});
