import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PermissionProfile } from "@resolvroom/protocol";
import { ControlClient, startDaemon } from "@resolvroom/daemon";
import type { DaemonHandle } from "@resolvroom/daemon";
import { MockRunner } from "@resolvroom/runner";
import { createMcpServer, formatOutcome, roomCommandMarkdown, roomInstructions } from "../src/index.js";
import type { DaemonApi } from "../src/index.js";

async function connect(api: DaemonApi): Promise<Client> {
  const server = createMcpServer(api);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0] as { text: string }).text;

describe("tools and prompt (fake daemon)", () => {
  it("lists consult, peers and the room prompt", async () => {
    const c = await connect({ consult: async () => { throw new Error("x"); }, peers: async () => [] });
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["consult", "peers"]);
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toEqual(["room"]);
  });

  it("room prompt carries the user's request and the steps", async () => {
    const c = await connect({ consult: async () => { throw new Error("x"); }, peers: async () => [] });
    const p = await c.getPrompt({ name: "room", arguments: { request: "why is the build flaky?", peer: "notebook-b" } });
    const text = (p.messages[0]?.content as { text: string }).text;
    expect(text).toContain("why is the build flaky?");
    expect(text).toContain('"notebook-b"');
    expect(text).toContain("`consult`");
    expect(text).toContain("never put secrets");
  });

  it("consult passes arguments to the daemon and formats the answer", async () => {
    let seen: unknown;
    const c = await connect({
      peers: async () => [],
      consult: async (req) => {
        seen = req;
        return { sessionId: "s", peer: "notebook-b", status: "solved", summary: "Use a mutex.", durationMs: 5, effective: { mode: "ask", capabilities: { read: true, write: false, exec: false, network: false } } };
      },
    });
    const r = await c.callTool({ name: "consult", arguments: { peer: "notebook-b", goal: "g", proposal: "p", ask_only: true, max_minutes: 2 } });
    expect(seen).toEqual({ peer: "notebook-b", goal: "g", proposal: "p", mode_cap: "ask", limits: { max_duration_s: 120 } });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("Consult with notebook-b: solved (applied there: ask mode, read)");
    expect(textOf(r)).toContain("Use a mutex.");
  });

  it("daemon errors become tool errors the agent can read", async () => {
    const c = await connect({ peers: async () => [], consult: async () => { throw new Error("the Resolv Room daemon is not running."); } });
    const r = await c.callTool({ name: "consult", arguments: { peer: "x", goal: "g", proposal: "p" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not running");
  });

  it("declined and rejected are normal answers; timeout is an error", () => {
    const base = { sessionId: "s", peer: "b", durationMs: 1, summary: "why" };
    expect(formatOutcome({ ...base, status: "declined" })).toContain("declined");
    expect(formatOutcome({ ...base, status: "timeout" })).toContain("timeout");
  });

  it("peers formats the list and the empty case", async () => {
    const empty = await connect({ consult: async () => { throw new Error("x"); }, peers: async () => [] });
    expect(textOf(await empty.callTool({ name: "peers", arguments: {} }))).toContain("No peers yet");
    const one = await connect({
      consult: async () => { throw new Error("x"); },
      peers: async () => [{ peer: "notebook-b", mode: "ask", capabilities: { read: true, write: false, exec: false, network: false } }],
    });
    expect(textOf(await one.callTool({ name: "peers", arguments: {} }))).toContain("- notebook-b");
  });

  it("rejects invalid arguments", async () => {
    const c = await connect({ consult: async () => { throw new Error("x"); }, peers: async () => [] });
    const r = await c.callTool({ name: "consult", arguments: { peer: "x", goal: "", proposal: "p" } }).catch((e: Error) => e);
    const failed = r instanceof Error || (r as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
  });
});

describe("/room command file", () => {
  it("is a Claude Code command with the arguments placeholder and only our two tools allowed", () => {
    const md = roomCommandMarkdown();
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("allowed-tools: mcp__resolvroom__consult, mcp__resolvroom__peers");
    expect(md).toContain("$ARGUMENTS");
    expect(roomInstructions("x")).toContain("exactly one peer");
  });
});

describe("through real daemons", () => {
  const open: DaemonHandle[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()?.close();
  });
  const READ_ONLY: PermissionProfile = { mode: "ask", capabilities: { read: true, write: false, exec: false, network: false } };

  it("MCP consult tool -> control socket -> daemon alpha -> HTTP -> daemon beta -> mock agent", async () => {
    const mk = async (name: string) => {
      const d = await startDaemon({
        home: mkdtempSync(join(tmpdir(), "rr-mcp-")), name, bind: "127.0.0.1", port: 0, identity: "dev",
        runner: new MockRunner({ name, delayMs: 10 }),
        prompter: { approve: async () => "allow" as const },
        heartbeatMs: 50, onError: () => undefined,
      });
      open.push(d);
      return d;
    };
    const alpha = await mk("alpha");
    const beta = await mk("beta");
    alpha.store.upsertPeer("beta", READ_ONLY, `http://127.0.0.1:${beta.port}`);
    beta.store.upsertPeer("alpha", READ_ONLY, `http://127.0.0.1:${alpha.port}`);

    const c = await connect(new ControlClient(alpha.store.socketPath));
    expect(textOf(await c.callTool({ name: "peers", arguments: {} }))).toContain("- beta");
    const r = await c.callTool({ name: "consult", arguments: { peer: "beta", goal: "review my fix", proposal: "I changed the cache key." } });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("Consult with beta: solved");
    expect(textOf(r)).toContain("[mock agent on beta]");
    expect(textOf(r)).toContain("I changed the cache key.");
  });
});
