import { mkdtempSync, writeFileSync } from "node:fs";
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
});
