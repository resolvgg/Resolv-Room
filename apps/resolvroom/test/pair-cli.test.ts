import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { QueuePrompter, startDaemon, ControlClient } from "@resolvroom/daemon";
import type { DaemonHandle } from "@resolvroom/daemon";
import { MockRunner } from "@resolvroom/runner";
import { main } from "../src/index.js";
import type { Io } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "rr-pc-"));
const open: DaemonHandle[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

function cli(home: string) {
  let out = "";
  const io: Io = { out: (s) => void (out += s), err: (s) => void (out += s), stdin: new PassThrough(), isTTY: false, env: { RESOLVROOM_HOME: home }, cwd: "/" };
  return { io, out: () => out };
}

async function daemon(name: string, queue?: QueuePrompter) {
  const d = await startDaemon({
    home: tmp(), name, bind: "127.0.0.1", port: 0, identity: "dev", runner: new MockRunner({ name, delayMs: 10 }),
    prompter: queue ?? { approve: async () => "allow" as const }, ...(queue ? { approvals: queue } : {}), heartbeatMs: 50, onError: () => undefined,
  });
  open.push(d);
  return d;
}

describe("resolvroom pair (CLI)", () => {
  it("one side shows a code, the other redeems it; both end up allowed", async () => {
    const alpha = await daemon("alpha");
    const beta = await daemon("beta");
    const host = cli(beta.store.home);
    const hostRun = main(["pair"], host.io);
    let code = "";
    for (let i = 0; i < 50 && !code; i++) {
      await new Promise((r) => setTimeout(r, 50));
      code = /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(host.out())?.[1] ?? "";
    }
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(host.out()).toContain("resolvroom pair beta ");

    const guest = cli(alpha.store.home);
    expect(await main(["pair", "beta", code, "--endpoint", `http://127.0.0.1:${beta.port}`, "--reply-endpoint", `http://127.0.0.1:${alpha.port}`], guest.io)).toBe(0);
    expect(await hostRun).toBe(0);
    expect(host.out()).toContain("Paired with alpha");
    expect(guest.out()).toContain("Paired with beta");
    const test = cli(alpha.store.home);
    expect(await main(["consult", "beta", "ping"], test.io)).toBe(0);
  }, 20000);

  it("a wrong code fails with a clear message", async () => {
    const alpha = await daemon("alpha");
    const beta = await daemon("beta");
    await new ControlClient(beta.store.socketPath).pairStart();
    const guest = cli(alpha.store.home);
    expect(await main(["pair", "beta", "AAAA-AAAA", "--endpoint", `http://127.0.0.1:${beta.port}`], guest.io)).toBe(1);
    expect(guest.out()).toContain("pairing failed");
  });
});

describe("resolvroom approvals (CLI)", () => {
  it("list, approve and deny a waiting request", async () => {
    const queue = new QueuePrompter();
    const alpha = await daemon("alpha");
    const vps = await daemon("vps", queue);
    const ro = { mode: "ask" as const, capabilities: { read: true, write: false, exec: false, network: false } };
    alpha.store.upsertPeer("vps", ro, `http://127.0.0.1:${vps.port}`);
    vps.store.upsertPeer("alpha", ro, `http://127.0.0.1:${alpha.port}`);
    const owner = cli(vps.store.home);
    expect(await main(["approvals"], owner.io)).toBe(0);
    expect(owner.out()).toContain("No requests waiting");

    const pending = new ControlClient(alpha.store.socketPath).consult({ peer: "vps", goal: "review please", proposal: "my plan" });
    let list = queue.list();
    for (let i = 0; i < 50 && list.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 40));
      list = queue.list();
    }
    const o2 = cli(vps.store.home);
    await main(["approvals"], o2.io);
    expect(o2.out()).toContain("review please");
    expect(o2.out()).toContain(`resolvroom approve ${list[0]?.id}`);
    expect(await main(["approve", (list[0]?.id as string).slice(0, 4)], o2.io)).toBe(0);
    expect((await pending).status).toBe("solved");

    const second = new ControlClient(alpha.store.socketPath).consult({ peer: "vps", goal: "again", proposal: "p2" });
    let l2 = queue.list();
    for (let i = 0; i < 50 && l2.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 40));
      l2 = queue.list();
    }
    expect(await main(["deny", l2[0]?.id as string], o2.io)).toBe(0);
    expect((await second).status).toBe("declined");
    const bad = cli(vps.store.home);
    expect(await main(["approve", "ffffff"], bad.io)).toBe(1);
  }, 20000);
});
