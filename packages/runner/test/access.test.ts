import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AccessRequest } from "@resolvroom/core";
import { decideAccess, startAccessBridge } from "../src/index.js";
import type { AccessContext } from "../src/index.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "rr-access-")));
const READ = { read: true, write: false, exec: false, network: false };

function setup(answer: "allow" | "deny" = "allow", caps = READ) {
  const home = tmp();
  const shared = join(home, "shared");
  const other = join(home, "other");
  mkdirSync(shared);
  mkdirSync(other);
  writeFileSync(join(other, "notes.md"), "hello");
  writeFileSync(join(other, ".env"), "SECRET=1");
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
  const asked: AccessRequest[] = [];
  const ctx: AccessContext = { folders: [shared], caps, home, cwd: shared, granted: [], ask: async (r) => (asked.push(r), answer) };
  return { home, shared, other, asked, ctx };
}

describe("decideAccess", () => {
  it("inside the shared folder: allowed without asking", async () => {
    const t = setup();
    expect((await decideAccess("Read", { file_path: join(t.shared, "a.ts") }, t.ctx)).behavior).toBe("allow");
    expect(t.asked).toEqual([]);
  });

  it("outside: asks once per file, then remembers for the session", async () => {
    const t = setup();
    const f = join(t.other, "notes.md");
    expect((await decideAccess("Read", { file_path: f }, t.ctx)).behavior).toBe("allow");
    expect((await decideAccess("Grep", { pattern: "x", path: f }, t.ctx)).behavior).toBe("allow");
    expect(t.asked).toEqual([{ tool: "Read", target: f }]);
  });

  it("outside and the owner says no: denied", async () => {
    const t = setup("deny");
    const d = await decideAccess("Read", { file_path: join(t.other, "notes.md") }, t.ctx);
    expect(d).toEqual({ behavior: "deny", message: expect.stringMatching(/did not allow/) });
  });

  it("secrets and system files are denied without asking, even if the owner would say yes", async () => {
    const t = setup("allow");
    for (const p of [join(t.other, ".env"), join(t.home, ".ssh", "id_ed25519"), join(t.other, "server.pem")]) {
      expect((await decideAccess("Read", { file_path: p }, t.ctx)).behavior).toBe("deny");
    }
    expect(t.asked).toEqual([]);
  });

  it("refuses too-broad targets and folder-wide content search outside", async () => {
    const t = setup();
    expect((await decideAccess("Glob", { pattern: "**", path: t.home }, t.ctx)).behavior).toBe("deny");
    expect((await decideAccess("Read", { file_path: "/" }, t.ctx)).behavior).toBe("deny");
    expect((await decideAccess("Grep", { pattern: "x", path: t.other }, t.ctx)).behavior).toBe("deny");
    expect(t.asked).toEqual([]);
  });

  it("a Glob grant only covers file names, not contents", async () => {
    const t = setup();
    expect((await decideAccess("Glob", { pattern: "*", path: t.other }, t.ctx)).behavior).toBe("allow");
    expect(t.asked).toHaveLength(1);
    await decideAccess("Read", { file_path: join(t.other, "notes.md") }, t.ctx);
    expect(t.asked).toHaveLength(2);
  });

  it("writes outside the folders, web without the capability and unknown tools are denied", async () => {
    const t = setup("allow", { read: true, write: true, exec: false, network: false });
    expect((await decideAccess("Write", { file_path: join(t.other, "x") }, t.ctx)).behavior).toBe("deny");
    expect((await decideAccess("Edit", { file_path: join(t.shared, "x") }, t.ctx)).behavior).toBe("allow");
    expect((await decideAccess("WebFetch", { url: "https://x" }, t.ctx)).behavior).toBe("deny");
    expect((await decideAccess("Bash", { command: "ls" }, t.ctx)).behavior).toBe("deny");
    expect(t.asked).toEqual([]);
  });

  it("extra_deny and out_of_scope=deny refuse without asking", async () => {
    const t = setup();
    const f = join(t.other, "notes.md");
    expect((await decideAccess("Read", { file_path: f }, { ...t.ctx, extraDeny: [`${t.other}/**`] })).behavior).toBe("deny");
    expect((await decideAccess("Read", { file_path: f }, { ...t.ctx, outOfScope: "deny" })).behavior).toBe("deny");
    expect(t.asked).toEqual([]);
  });

  it("with no one to ask, outside reads are denied", async () => {
    const t = setup();
    const { ask: _ask, ...noAsk } = t.ctx;
    expect((await decideAccess("Read", { file_path: join(t.other, "notes.md") }, noAsk)).behavior).toBe("deny");
  });
});

describe("access bridge (MCP stdio <-> runner socket)", () => {
  it("answers Claude Code's permission tool call with the runner's decision", async () => {
    const t = setup();
    const bridge = await startAccessBridge(t.ctx);
    try {
      const cfg = JSON.parse(readFileSync(bridge.configPath, "utf8")) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
      const s = cfg.mcpServers.resolvroom_access!;
      expect(s.args[0]).toBe(fileURLToPath(new URL("../dist/access-bridge.js", import.meta.url)));
      const child = spawn(s.command, s.args, { env: { ...process.env, ...s.env }, stdio: ["pipe", "pipe", "inherit"] });
      const lines = createInterface({ input: child.stdout });
      const replies: Array<{ id: number; result?: { content?: Array<{ text: string }>; tools?: unknown[] } }> = [];
      const next = () => new Promise<(typeof replies)[number]>((r) => lines.once("line", (l) => r(JSON.parse(l))));
      const call = async (m: object) => {
        const p = next();
        child.stdin.write(`${JSON.stringify(m)}\n`);
        return p;
      };
      await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(JSON.stringify(list.result?.tools)).toContain('"approve"');
      const f = join(t.other, "notes.md");
      const res = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Read", input: { file_path: f } } } });
      expect(JSON.parse(res.result?.content?.[0]?.text ?? "{}")).toEqual({ behavior: "allow", updatedInput: { file_path: f } });
      const sec = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Read", input: { file_path: join(t.other, ".env") } } } });
      expect(JSON.parse(sec.result?.content?.[0]?.text ?? "{}").behavior).toBe("deny");
      expect(t.asked).toEqual([{ tool: "Read", target: f }]);
      child.kill();
    } finally {
      bridge.close();
    }
  });
});
