import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePermissions } from "@resolvroom/protocol";
import type { EffectivePermissions, PermissionProfile } from "@resolvroom/protocol";
import { ClaudeCodeRunner, MockRunner, parseAnswer } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "rr-runner-"));

function perms(profile: PermissionProfile, tags: string[] = []): EffectivePermissions {
  const r = resolvePermissions({ peerProfile: profile, ceiling: "auto", peerTags: tags });
  if (!r.allowed) throw new Error("not allowed");
  return r;
}
const ASK: PermissionProfile = { mode: "ask", capabilities: { read: true, write: true, exec: true, network: true } };

function fakeClaude(dir: string, body = ""): { cmd: string; out: string } {
  const out = join(dir, "out.json");
  const cmd = join(dir, "claude");
  writeFileSync(
    cmd,
    `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.includes("--version")) { console.log("9.9.9 (Fake)"); process.exit(0); }
let stdin = "";
process.stdin.on("data", (d) => (stdin += d)).on("end", () => {
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin }));
  ${body || `console.log(JSON.stringify({ type: "result", is_error: false, result: "Looks fine.\\nSTATUS: solved" }));`}
});
`,
  );
  chmodSync(cmd, 0o755);
  return { cmd, out };
}

describe("restrict / describeAccess", () => {
  it("ask mode: read only, nothing else, whatever the profile says", () => {
    const work = tmp();
    const r = new ClaudeCodeRunner({ workdir: work, home: "/nonexistent-home" });
    expect(r.restrict(perms(ASK))).toEqual({ read: true, write: false, exec: false, network: false });
    expect(r.describeAccess(perms(ASK))).toContain(`read files in`);
    expect(r.describeAccess(perms(ASK))).not.toContain("edit");
  });

  it("refuses unsafe folders: home, root, missing, hard-deny", () => {
    const home = tmp();
    mkdirSync(join(home, ".ssh"));
    for (const workdir of [home, "/", join(home, "missing"), join(home, ".ssh"), "relative/path"]) {
      const r = new ClaudeCodeRunner({ workdir, home });
      expect(r.restrict(perms(ASK)), workdir).toBeNull();
    }
  });

  it("auto mode: write and network are kept, exec never", () => {
    const root = tmp();
    const profile: PermissionProfile = {
      mode: "auto",
      capabilities: { read: true, write: true, exec: true, network: true },
      scope: { roots: [root] },
      expires_at: null,
    };
    const r = new ClaudeCodeRunner({ workdir: tmp(), home: "/nonexistent-home" });
    const p = perms(profile, ["tag:resolvroom-auto"]);
    expect(p.mode).toBe("auto");
    expect(r.restrict(p)).toEqual({ read: true, write: true, exec: false, network: true });
  });

  it("downgraded auto (no tag) uses the ask rules", () => {
    const root = tmp();
    const profile: PermissionProfile = {
      mode: "auto",
      capabilities: { read: true, write: true, exec: false, network: false },
      scope: { roots: [root] },
      expires_at: null,
    };
    const r = new ClaudeCodeRunner({ workdir: tmp(), home: "/nonexistent-home" });
    const p = perms(profile, []);
    expect(p.mode).toBe("ask");
    expect(r.restrict(p)?.write).toBe(false);
  });
});

describe("buildArgs", () => {
  it("ask: read-only tools, dontAsk, no MCP, no user settings, cwd = workdir", () => {
    const work = tmp();
    const r = new ClaudeCodeRunner({ workdir: work, home: "/nonexistent-home" });
    const { args, cwd } = r.buildArgs(perms(ASK));
    expect(cwd).toBe(work);
    expect(args).toContain("--tools=Read,Grep,Glob");
    expect(args.join(" ")).toContain("--permission-mode dontAsk");
    expect(args).toContain("--strict-mcp-config");
    expect(args.join(" ")).toContain("--setting-sources project,local");
    expect(args).toContain("Read(**/.env)");
    expect(args.join(" ")).not.toMatch(/Bash|Edit|Write|WebFetch/);
  });

  it("auto with two roots: cwd is the first, the other is --add-dir, write uses acceptEdits", () => {
    const [a, b] = [tmp(), tmp()];
    const profile: PermissionProfile = {
      mode: "auto",
      capabilities: { read: true, write: true, exec: true, network: false },
      scope: { roots: [a, b] },
      expires_at: null,
    };
    const r = new ClaudeCodeRunner({ workdir: tmp(), home: "/nonexistent-home" });
    const { args, cwd } = r.buildArgs(perms(profile, ["tag:resolvroom-auto"]));
    expect(cwd).toBe(a);
    expect(args.join(" ")).toContain(`--add-dir ${b}`);
    expect(args).toContain("--tools=Read,Grep,Glob,Edit,Write");
    expect(args.join(" ")).toContain("--permission-mode acceptEdits");
    expect(args.join(" ")).not.toContain("Bash");
  });

  it("no read capability means no tools at all", () => {
    const r = new ClaudeCodeRunner({ workdir: tmp(), home: "/nonexistent-home" });
    const { args } = r.buildArgs(perms({ mode: "ask", capabilities: { read: false, write: false, exec: false, network: false } }));
    expect(args).toContain("--tools=");
  });
});

describe("run with a fake claude binary", () => {
  it("sends the prompt on stdin, runs in the workdir, parses STATUS", async () => {
    const dir = tmp();
    const work = tmp();
    const { cmd, out } = fakeClaude(dir);
    const r = new ClaudeCodeRunner({ command: cmd, workdir: work, home: "/nonexistent-home" });
    expect(await r.available()).toBe(true);
    const res = await r.run({
      sessionId: "s",
      peer: "notebook-a",
      goal: "fix the cache bug",
      proposal: "evict on write",
      permissions: perms(ASK),
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ status: "solved", summary: "Looks fine." });
    const seen = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; cwd: string; stdin: string };
    expect(seen.cwd).toBe(work);
    expect(seen.stdin).toContain("fix the cache bug");
    expect(seen.stdin).toContain("evict on write");
    expect(seen.stdin).toContain("notebook-a");
    expect(seen.argv).toContain("--append-system-prompt");
  });

  it("not available when the binary does not exist", async () => {
    const r = new ClaudeCodeRunner({ command: "/definitely/not/here", workdir: tmp() });
    expect(await r.available()).toBe(false);
  });

  it("a consult from a peer can also read what that peer sent (inbox/<peer>), and only that", async () => {
    const dir = tmp();
    const work = tmp();
    const inbox = tmp();
    mkdirSync(join(inbox, "laptop"));
    mkdirSync(join(inbox, "other"));
    const { cmd, out } = fakeClaude(dir);
    const r = new ClaudeCodeRunner({ command: cmd, workdir: work, home: "/nonexistent-home", inbox });
    await r.run({ sessionId: "s", peer: "laptop", goal: "g", proposal: "p", permissions: perms(ASK), signal: new AbortController().signal });
    const argv = (JSON.parse(readFileSync(out, "utf8")) as { argv: string[] }).argv;
    const i = argv.indexOf("--add-dir");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe(join(inbox, "laptop"));
    expect(argv.join(" ")).not.toContain(join(inbox, "other"));
  });

  it("abort kills the process", async () => {
    const dir = tmp();
    const { cmd } = fakeClaude(dir, "setInterval(() => {}, 1000);");
    const r = new ClaudeCodeRunner({ command: cmd, workdir: tmp(), home: "/nonexistent-home" });
    const ctl = new AbortController();
    const p = r.run({ sessionId: "s", peer: "a", goal: "g", proposal: "p", permissions: perms(ASK), signal: ctl.signal });
    setTimeout(() => ctl.abort(), 300);
    await expect(p).rejects.toThrow(/aborted/);
  });

  it("a claude error becomes an exception", async () => {
    const dir = tmp();
    const { cmd } = fakeClaude(dir, `console.log(JSON.stringify({ is_error: true, result: "rate limited" }));`);
    const r = new ClaudeCodeRunner({ command: cmd, workdir: tmp(), home: "/nonexistent-home" });
    await expect(
      r.run({ sessionId: "s", peer: "a", goal: "g", proposal: "p", permissions: perms(ASK), signal: new AbortController().signal }),
    ).rejects.toThrow(/rate limited/);
  });
});

describe("parseAnswer", () => {
  it("defaults to partial without a STATUS line", () => {
    expect(parseAnswer("just text")).toEqual({ status: "partial", summary: "just text" });
  });
  it("extracts status case-insensitively", () => {
    expect(parseAnswer("a\nstatus: Unsolved\n")).toEqual({ status: "unsolved", summary: "a" });
  });
});

describe("MockRunner", () => {
  it("echoes without touching anything", async () => {
    const m = new MockRunner({ name: "b", delayMs: 1 });
    const res = await m.run({ sessionId: "s", peer: "a", goal: "g", proposal: "p", permissions: perms(ASK), signal: new AbortController().signal });
    expect(res.status).toBe("solved");
    expect(res.summary).toContain("mock agent on b");
  });
});
