import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDaemon } from "@resolvroom/daemon";
import type { DaemonHandle } from "@resolvroom/daemon";
import { ConfigStore } from "@resolvroom/core";
import { MockRunner } from "@resolvroom/runner";
import { main } from "../src/index.js";
import type { Io } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "dist", "bin.js");
const tmp = () => mkdtempSync(join(tmpdir(), "rr-cli-"));

function io(home: string, extra: Partial<Io> = {}) {
  let out = "";
  let err = "";
  const i: Io = {
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    stdin: new PassThrough(),
    isTTY: false,
    env: { RESOLVROOM_HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude") },
    cwd: "/work",
    ...extra,
  };
  return { io: i, out: () => out, err: () => err };
}

describe("peer / ceiling", () => {
  it("allow (default ask, read-only), list, remove", async () => {
    const home = tmp();
    const t = io(home);
    expect(await main(["peer", "allow", "notebook-b"], t.io)).toBe(0);
    expect(await main(["peer", "list"], t.io)).toBe(0);
    expect(t.out()).toContain("notebook-b  mode=ask  caps=read");
    expect(new ConfigStore(home).load().peers[0]?.profile.capabilities).toEqual({ read: true, write: false, exec: false, network: false });
    expect(await main(["peer", "remove", "notebook-b"], t.io)).toBe(0);
    expect(new ConfigStore(home).load().peers).toEqual([]);
  });

  it("auto needs scope and expiry; exec is refused; scope is made absolute", async () => {
    const home = tmp();
    const bad = (args: string[]) => {
      const t = io(home);
      return main(["peer", "allow", "b", ...args], t.io).then((code) => ({ code, err: t.err() }));
    };
    expect(await bad(["--mode", "auto"])).toMatchObject({ code: 2 });
    expect((await bad(["--mode", "auto", "--scope", "/srv/app"])).err).toContain("--expires");
    expect((await bad(["--exec"])).err).toContain("not supported");
    expect((await bad(["--scope", "/x"])).err).toContain("only apply to --mode auto");
    expect((await bad(["--expires", "5x", "--mode", "auto", "--scope", "/a"])).err).toContain("invalid duration");

    const t = io(home);
    expect(await main(["peer", "allow", "b", "--mode", "auto", "--scope", "proj", "--expires", "8h", "--write"], t.io)).toBe(0);
    const p = new ConfigStore(home).load().peers[0]?.profile;
    expect(p?.scope?.roots).toEqual(["/work/proj"]);
    expect(Date.parse(p?.expires_at as string) - Date.now()).toBeGreaterThan(7.9 * 3600_000);
    expect(p?.capabilities.write).toBe(true);
    expect(t.out()).toContain("ceiling");
    expect(t.out()).toContain("tag:resolvroom-auto");
  });

  it("ceiling get/set", async () => {
    const home = tmp();
    const t = io(home);
    await main(["ceiling"], t.io);
    expect(t.out()).toContain("ceiling: ask");
    await main(["ceiling", "auto"], t.io);
    expect(new ConfigStore(home).load().ceiling).toBe("auto");
  });
});

describe("misc", () => {
  it("help, unknown command, consult usage, daemon not running", async () => {
    const t = io(tmp());
    expect(await main([], t.io)).toBe(0);
    expect(t.out()).toContain("resolvroom <command>");
    const u = io(tmp());
    expect(await main(["bogus"], u.io)).toBe(2);
    expect(u.err()).toContain("unknown command");
    expect(await main(["consult", "x"], u.io)).toBe(2);
    const n = io(tmp());
    expect(await main(["status"], n.io)).toBe(1);
    expect(n.err()).toContain("not running");
  });

  it("start in dev mode requires --name", async () => {
    const t = io(tmp());
    expect(await main(["start", "--insecure-dev-identity"], t.io)).toBe(2);
    expect(t.err()).toContain("--name");
  });

  it("install-claude --print shows the plan and writes nothing", async () => {
    const home = tmp();
    const t = io(home);
    expect(await main(["install-claude", "--print"], t.io)).toBe(0);
    expect(t.out()).toContain("claude mcp add --scope user");
    // regression: -e takes a list, so the server name must come before it
    expect(t.out()).toContain("add --scope user resolvroom -e RESOLVROOM_HOME=");
    expect(t.out()).toContain("/room");
    expect(t.out()).toContain("allowed-tools: mcp__resolvroom__consult");
    expect(existsSync(join(home, "claude", "commands", "room.md"))).toBe(false);
  });

  it("install-claude without a terminal and without --yes changes nothing", async () => {
    const home = tmp();
    const t = io(home);
    expect(await main(["install-claude"], t.io)).toBe(1);
    expect(existsSync(join(home, "claude", "commands", "room.md"))).toBe(false);
  });

  it("install-claude --yes writes the /room command (claude CLI missing -> clear message)", async () => {
    const home = tmp();
    const t = io(home, { env: { RESOLVROOM_HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), PATH: "/nonexistent" } });
    const code = await main(["install-claude", "--yes"], t.io);
    expect(readFileSync(join(home, "claude", "commands", "room.md"), "utf8")).toContain("$ARGUMENTS");
    expect(code).toBe(1);
    expect(t.err()).toContain("claude mcp add");
  });
});

describe("real processes", () => {
  const open: DaemonHandle[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()?.close();
  });

  it("`resolvroom mcp` over stdio talks to a daemon: consult tool works end to end", async () => {
    const mk = async (name: string) => {
      const d = await startDaemon({
        home: tmp(), name, bind: "127.0.0.1", port: 0, identity: "dev",
        runner: new MockRunner({ name, delayMs: 10 }), prompter: { approve: async () => "allow" as const },
        heartbeatMs: 50, onError: () => undefined,
      });
      open.push(d);
      return d;
    };
    const alpha = await mk("alpha");
    const beta = await mk("beta");
    const ro = { mode: "ask" as const, capabilities: { read: true, write: false, exec: false, network: false } };
    alpha.store.upsertPeer("beta", ro, `http://127.0.0.1:${beta.port}`);
    beta.store.upsertPeer("alpha", ro, `http://127.0.0.1:${alpha.port}`);

    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [BIN, "mcp"],
        env: { PATH: process.env.PATH ?? "", RESOLVROOM_HOME: alpha.store.home },
      }),
    );
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["consult", "peers", "send_files"]);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(["room"]);
    const r = (await client.callTool({ name: "consult", arguments: { peer: "beta", goal: "g", proposal: "check my fix" } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(r.isError).toBe(false);
    expect(r.content[0]?.text).toContain("[mock agent on beta]");
    await client.close();
  }, 30000);

  it("the local demo runs end to end", async () => {
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const c = spawn(process.execPath, [join(here, "..", "scripts", "demo-local.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      c.stdout.on("data", (d) => (text += d));
      c.stderr.on("data", (d) => (text += d));
      c.on("close", (code) => resolve({ code, text }));
    });
    expect(out.text).toContain("Demo OK.");
    expect(out.text).toContain("[mock agent on beta]");
    expect(out.text).toContain("beta: rejected");
    expect(out.code).toBe(0);
  }, 60000);
});
