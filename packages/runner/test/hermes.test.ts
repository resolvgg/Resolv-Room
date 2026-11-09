import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePermissions } from "@resolvroom/protocol";
import type { EffectivePermissions, PermissionProfile } from "@resolvroom/protocol";
import { HermesRunner, buildHermesQuery, stripHermesNotices } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "rr-hermes-"));
const ALL = { read: true, write: true, exec: true, network: true };

function perms(profile: PermissionProfile, tags: string[] = []): EffectivePermissions {
  const r = resolvePermissions({ peerProfile: profile, ceiling: "auto", peerTags: tags });
  if (!r.allowed) throw new Error("not allowed");
  return r;
}
const ASK = (): EffectivePermissions => perms({ mode: "ask", capabilities: ALL });
const AUTO = (): EffectivePermissions => perms({ mode: "auto", capabilities: ALL, scope: { roots: [tmp()] }, expires_at: null }, ["tag:resolvroom-auto"]);

function fakeHermes(dir: string, body = 'console.log("Fine.\\nSTATUS: solved"); console.error("\\nsession_id: x");'): { cmd: string; out: string } {
  const out = join(dir, "out.json");
  const cmd = join(dir, "hermes");
  writeFileSync(
    cmd,
    `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.includes("--version")) { console.log("Hermes Agent v9.9.9"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
${body}
`,
  );
  chmodSync(cmd, 0o755);
  return { cmd, out };
}

describe("HermesRunner permissions", () => {
  it("never grants files, shell or write; network only in auto", () => {
    const r = new HermesRunner({ workdir: tmp(), home: "/nonexistent-home" });
    expect(r.restrict(ASK())).toEqual({ read: false, write: false, exec: false, network: false });
    expect(r.restrict(AUTO())).toEqual({ read: false, write: false, exec: false, network: true });
    expect(r.describeAccess(ASK())).toMatch(/no file or web access/);
  });

  it("refuses to run from the home folder or /", () => {
    const home = tmp();
    expect(new HermesRunner({ workdir: home, home }).restrict(ASK())).toBeNull();
    expect(new HermesRunner({ workdir: "/", home }).restrict(ASK())).toBeNull();
  });

  it("toolsets: only the inert one in ask; web added in auto; never terminal, file or MCP", () => {
    const r = new HermesRunner({ workdir: tmp(), home: "/nonexistent-home" });
    const ask = r.buildArgs(ASK(), "q").args;
    expect(ask.slice(0, 4)).toEqual(["chat", "-q", "q", "-Q"]);
    expect(ask[ask.indexOf("-t") + 1]).toBe("todo");
    expect(ask).toContain("--ignore-rules");
    expect(ask).toEqual(expect.arrayContaining(["--source", "tool"]));
    const auto = r.buildArgs(AUTO(), "q").args;
    expect(auto[auto.indexOf("-t") + 1]).toBe("todo,web");
    expect(auto.join(" ")).not.toMatch(/terminal|file|--yolo/);
  });
});

describe("HermesRunner.run", () => {
  it("passes the consultation as -q, runs in the workdir and parses the answer", async () => {
    const dir = tmp();
    const work = tmp();
    const { cmd, out } = fakeHermes(dir);
    const r = new HermesRunner({ command: cmd, workdir: work, home: "/nonexistent-home" });
    expect(await r.available()).toBe(true);
    const res = await r.run({ sessionId: "s", peer: "laptop", goal: "fix bug", proposal: "patch X", permissions: ASK(), signal: new AbortController().signal });
    expect(res).toEqual({ status: "solved", summary: "Fine." });
    const seen = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; cwd: string };
    const q = seen.argv[seen.argv.indexOf("-q") + 1] ?? "";
    expect(q).toContain("untrusted input");
    expect(q).toContain('Consultation from the agent on "laptop"');
    expect(q).toContain("patch X");
    expect(seen.cwd).toBe(work);
  });

  it("a failed run becomes an error with Hermes' message (without the session id line)", async () => {
    const dir = tmp();
    const { cmd } = fakeHermes(dir, 'console.error("Error: invalid model\\n\\nsession_id: abc"); process.exit(1);');
    const r = new HermesRunner({ command: cmd, workdir: tmp(), home: "/nonexistent-home" });
    await expect(r.run({ sessionId: "s", peer: "p", goal: "g", proposal: "x", permissions: ASK(), signal: new AbortController().signal })).rejects.toThrow(
      /code 1: Error: invalid model$/,
    );
  });

  it("drops Hermes' leading notices from the answer", () => {
    expect(stripHermesNotices("  ⚠ tirith security scanner enabled but not available\nThe answer\n⚠ kept\n")).toBe("The answer\n⚠ kept");
  });

  it("huge proposals are truncated to fit one argv string", () => {
    const q = buildHermesQuery("p", "g", "é".repeat(200_000));
    expect(Buffer.byteLength(q)).toBeLessThanOrEqual(120_000);
    expect(q).toContain("truncated by Resolv Room");
  });
});

const real = process.env.RESOLVROOM_REAL_HERMES === "1";
describe.skipIf(!real)("real Hermes (RESOLVROOM_REAL_HERMES=1)", () => {
  it("answers a trivial consultation", async () => {
    const r = new HermesRunner({ workdir: tmp() });
    const res = await r.run({ sessionId: "s", peer: "p", goal: "sanity check", proposal: "Is 2+2=4? Answer briefly.", permissions: ASK(), signal: new AbortController().signal });
    expect(res.summary.length).toBeGreaterThan(0);
  }, 300_000);
});
