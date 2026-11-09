import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { hermesMcpAddArgs, installHermesCommand } from "../src/hermes.js";
import { updateCommand } from "../src/update.js";
import type { Io } from "../src/util.js";

const tmp = () => mkdtempSync(join(tmpdir(), "rr-hu-"));

function ctx(env: NodeJS.ProcessEnv, cwd: string) {
  let out = "";
  const io: Io = { out: (s) => void (out += s), err: (s) => void (out += s), stdin: new PassThrough(), isTTY: false, env, cwd };
  return { io, out: () => out };
}

function script(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("install-hermes", () => {
  it("mcp add args: --env before --command, --args last", () => {
    expect(hermesMcpAddArgs("/n", "/b.js", { RESOLVROOM_HOME: "/h" })).toEqual(["mcp", "add", "resolvroom", "--env", "RESOLVROOM_HOME=/h", "--command", "/n", "--args", "/b.js", "mcp"]);
  });

  it("writes the /room skill and registers the MCP server, answering Hermes' prompts", async () => {
    const dir = tmp();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "hermes.log");
    script(
      join(bin, "hermes"),
      `const fs = require("fs");
const a = process.argv.slice(2);
if (a[0] === "mcp" && a[1] === "list") { console.log("  No MCP servers configured."); process.exit(0); }
let stdin = ""; process.stdin.on("data", (d) => (stdin += d)).on("end", () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ a, stdin }));
  console.log("  Enable all 2 tools? [Y/n/select]: \\n  ✓ Saved 'resolvroom' to config.yaml (2/2 tools enabled)");
});`,
    );
    const hh = join(dir, "hermes-home");
    const t = ctx({ PATH: `${bin}:${process.env.PATH}`, HOME: dir, HERMES_HOME: hh }, dir);
    expect(await installHermesCommand(["--yes"], t.io)).toBe(0);
    const skill = readFileSync(join(hh, "skills", "resolvroom", "room", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: room\n/);
    expect(skill).toContain("`consult`");
    const seen = JSON.parse(readFileSync(log, "utf8")) as { a: string[]; stdin: string };
    expect(seen.a.slice(0, 3)).toEqual(["mcp", "add", "resolvroom"]);
    expect(seen.a.slice(-1)).toEqual(["mcp"]);
    expect(seen.stdin).toMatch(/^y\n/);
    expect(t.out()).toContain('registered the MCP server "resolvroom" in Hermes');
  });

  it("does not register twice", async () => {
    const dir = tmp();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    script(join(bin, "hermes"), `if (process.argv[3] === "list") { console.log("  resolvroom       node /x   all   ✓ enabled"); process.exit(0); } process.exit(9);`);
    const t = ctx({ PATH: `${bin}:${process.env.PATH}`, HOME: dir, HERMES_HOME: join(dir, "hh") }, dir);
    expect(await installHermesCommand(["--yes"], t.io)).toBe(0);
    expect(t.out()).toContain("already registered in Hermes");
  });
});

describe("update", () => {
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

  function fixture() {
    const dir = tmp();
    const origin = join(dir, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "a.txt"), "1");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "first");
    const src = join(dir, "src");
    git(dir, "clone", "-q", "--branch", "main", origin, src);
    mkdirSync(join(src, "apps", "resolvroom", "dist"), { recursive: true });
    const binJs = join(src, "apps", "resolvroom", "dist", "bin.js");
    writeFileSync(binJs, "");
    const fakeBin = join(dir, "bin");
    mkdirSync(fakeBin);
    const pnpmLog = join(dir, "pnpm.log");
    script(join(fakeBin, "pnpm"), `require("fs").appendFileSync(${JSON.stringify(pnpmLog)}, process.argv.slice(2).join(" ") + "\\n");`);
    const t = ctx({ PATH: `${fakeBin}:${process.env.PATH}`, HOME: dir }, dir);
    return { origin, src, binJs, pnpmLog, t };
  }

  it("says so when already up to date", async () => {
    const f = fixture();
    expect(await updateCommand([], f.t.io, f.binJs)).toBe(0);
    expect(f.t.out()).toContain("Already up to date");
    expect(existsSync(f.pnpmLog)).toBe(false);
  });

  it("pulls, rebuilds and lists what changed", async () => {
    const f = fixture();
    writeFileSync(join(f.origin, "a.txt"), "2");
    git(f.origin, "commit", "-q", "-am", "second change");
    expect(await updateCommand([], f.t.io, f.binJs)).toBe(0);
    expect(readFileSync(join(f.src, "a.txt"), "utf8")).toBe("2");
    expect(readFileSync(f.pnpmLog, "utf8")).toContain("install --frozen-lockfile\n-r build");
    expect(f.t.out()).toMatch(/Updated [0-9a-f]{7} -> [0-9a-f]{7}/);
    expect(f.t.out()).toContain("second change");
    expect(f.t.out()).toContain("No background service installed");
  });
});
