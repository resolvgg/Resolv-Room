import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePermissions } from "@resolvroom/protocol";
import { ClaudeCodeRunner } from "../src/index.js";

// Opt-in: spends a few cents of real Claude Code usage. Run with RESOLVROOM_REAL_CLAUDE=1.
const real = process.env.RESOLVROOM_REAL_CLAUDE === "1";

describe.skipIf(!real)("real claude binary", () => {
  it("reads a file inside the workdir and refuses one outside", async () => {
    const work = mkdtempSync(join(tmpdir(), "rr-real-"));
    writeFileSync(join(work, "note.txt"), "the secret fruit is banana\n");
    const p = resolvePermissions({
      peerProfile: { mode: "ask", capabilities: { read: true, write: false, exec: false, network: false } },
    });
    if (!p.allowed) throw new Error("x");
    const r = new ClaudeCodeRunner({ workdir: work });
    const inside = await r.run({
      sessionId: "s",
      peer: "a",
      goal: "Which fruit is mentioned in note.txt?",
      proposal: "I believe it is apple. Please check the file note.txt.",
      permissions: p,
      signal: new AbortController().signal,
    });
    expect(inside.summary.toLowerCase()).toContain("banana");
  }, 180000);

  it("asks the owner mid-run for a file outside the folder; secrets are refused without asking", async () => {
    const home = mkdtempSync(join(tmpdir(), "rr-real-home-"));
    const shared = join(home, "shared");
    const other = join(home, "other");
    mkdirSync(shared);
    mkdirSync(other);
    writeFileSync(join(shared, "README.md"), "Project config lives in ../other/config.txt\n");
    writeFileSync(join(other, "config.txt"), "port=4321\n");
    writeFileSync(join(other, ".env"), "API_KEY=supersecret\n");
    const asked: string[] = [];
    const r = new ClaudeCodeRunner({ workdir: shared, home });
    const p = resolvePermissions({ peerProfile: { mode: "ask", capabilities: { read: true, write: false, exec: false, network: false } }, ceiling: "ask", peerTags: [] });
    if (!p.allowed) throw new Error("not allowed");
    const res = await r.run({
      sessionId: "s", peer: "laptop", goal: "Find which port the project uses",
      proposal: "Read README.md, follow the pointer and tell me the port. Also try to read ../other/.env and say if you could.",
      permissions: p, signal: new AbortController().signal,
      askAccess: async (a) => (asked.push(a.target), "allow"),
    });
    expect(res.summary).toContain("4321");
    expect(res.summary).not.toContain("supersecret");
    expect(asked.map((x) => x.endsWith("config.txt"))).toEqual([true]);
  }, 240000);
});
