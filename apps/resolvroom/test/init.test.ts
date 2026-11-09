import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "@resolvroom/core";
import { initCommand, mergeTags, tagsAreSet, ACL_SNIPPET } from "../src/init.js";
import { launchdPlist, servicePaths, systemdUnit } from "../src/service.js";
import type { Io } from "../src/util.js";

const tmp = () => mkdtempSync(join(tmpdir(), "rr-init-"));

/**
 * A stand-in `tailscale` binary. State lives in a JSON file. `allowed` lists the tags the (fake) tailnet policy accepts;
 * `set --advertise-tags` fails with a policy error for any other tag, like the real one does.
 */
function fakeTailscale(dir: string, state: { tags: string[]; allowed: string[]; denyPermission?: boolean }): { bin: string; stateFile: string } {
  const stateFile = join(dir, "ts-state.json");
  writeFileSync(stateFile, JSON.stringify(state));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "tailscale");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("fs");
const f = ${JSON.stringify(stateFile)};
const st = JSON.parse(fs.readFileSync(f, "utf8"));
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "status") {
  console.log(JSON.stringify({ Self: { HostName: "VPS-1", DNSName: "vps-1.example.ts.net.", TailscaleIPs: ["100.64.0.7"], Tags: st.tags } }));
} else if (cmd === "set") {
  if (st.denyPermission) { console.error("Access denied: checkPrefs access denied"); process.exit(1); }
  const arg = rest.find((a) => a.startsWith("--advertise-tags="));
  const tags = arg.slice("--advertise-tags=".length).split(",");
  const bad = tags.filter((t) => !st.allowed.includes(t));
  if (bad.length) { console.error("requested tags [" + bad.join(" ") + "] are invalid or not permitted"); process.exit(1); }
  st.tags = tags; fs.writeFileSync(f, JSON.stringify(st));
} else { process.exit(1); }
`,
  );
  chmodSync(script, 0o755);
  return { bin, stateFile };
}

function ctx(dir: string, bin: string, extra: Partial<Io> = {}) {
  let out = "";
  const stdin = new PassThrough();
  const io: Io = {
    out: (s) => void (out += s),
    err: (s) => void (out += s),
    stdin,
    isTTY: false,
    env: { PATH: `${bin}:${process.env.PATH}`, RESOLVROOM_HOME: join(dir, "home"), HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "claude") },
    cwd: dir,
    ...extra,
  };
  return { io, stdin, out: () => out };
}

const noClaude = { installClaude: async () => 0 };
const ALL = ["tag:resolvroom", "tag:resolvroom-ask", "tag:resolvroom-auto"];

describe("tag helpers", () => {
  it("mergeTags keeps unrelated tags and swaps the ask/auto marker", () => {
    expect(mergeTags(["tag:db"], false)).toEqual(["tag:db", "tag:resolvroom", "tag:resolvroom-ask"]);
    expect(mergeTags(["tag:resolvroom", "tag:resolvroom-ask", "tag:db"], true)).toEqual(["tag:db", "tag:resolvroom", "tag:resolvroom-auto"]);
  });
  it("tagsAreSet needs the base tag and exactly the wanted marker", () => {
    expect(tagsAreSet(["tag:resolvroom", "tag:resolvroom-ask"], false)).toBe(true);
    expect(tagsAreSet(["tag:resolvroom", "tag:resolvroom-ask", "tag:resolvroom-auto"], true)).toBe(false);
    expect(tagsAreSet(["tag:resolvroom-ask"], false)).toBe(false);
  });
});

describe("init wizard (fake tailscale)", () => {
  it("--yes: identifies the machine, sets the ask tags, keeps other tags, writes ceiling ask", async () => {
    const dir = tmp();
    const { bin, stateFile } = fakeTailscale(dir, { tags: ["tag:db"], allowed: [...ALL, "tag:db"] });
    const t = ctx(dir, bin);
    const code = await initCommand(["--yes", "--no-claude"], t.io, noClaude);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).tags).toEqual(["tag:db", "tag:resolvroom", "tag:resolvroom-ask"]);
    expect(new ConfigStore(join(dir, "home")).load().ceiling).toBe("ask");
    expect(t.out()).toContain('Node name "vps-1"');
    expect(t.out()).toContain("Tags applied");
    expect(t.out()).toContain("resolvroom pair vps-1 <code>");
    expect(t.out()).toContain("resolvroom approvals --watch");
  });

  it("--auto-eligible tags the machine eligible for auto and raises the ceiling", async () => {
    const dir = tmp();
    const { bin, stateFile } = fakeTailscale(dir, { tags: ["tag:resolvroom", "tag:resolvroom-ask"], allowed: ALL });
    const t = ctx(dir, bin);
    expect(await initCommand(["--yes", "--no-claude", "--auto-eligible"], t.io, noClaude)).toBe(0);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).tags).toEqual(["tag:resolvroom", "tag:resolvroom-auto"]);
    expect(new ConfigStore(join(dir, "home")).load().ceiling).toBe("auto");
  });

  it("already tagged: nothing is changed", async () => {
    const dir = tmp();
    const { bin } = fakeTailscale(dir, { tags: ["tag:resolvroom", "tag:resolvroom-ask"], allowed: [] });
    const t = ctx(dir, bin);
    expect(await initCommand(["--yes", "--no-claude"], t.io, noClaude)).toBe(0);
    expect(t.out()).toContain("Already tagged");
  });

  it("tags missing from the policy: prints the snippet, waits, retries after Enter, then succeeds", async () => {
    const dir = tmp();
    const { bin, stateFile } = fakeTailscale(dir, { tags: [], allowed: [] });
    const t = ctx(dir, bin, { isTTY: true });
    // answers: auto-eligible? n / (fail, snippet) Enter after fixing / service? n
    t.stdin.write("n\n");
    const run = initCommand(["--no-claude"], t.io, noClaude);
    await new Promise((r) => setTimeout(r, 500));
    expect(t.out()).toContain("not declared in your tailnet policy");
    expect(t.out()).toContain(ACL_SNIPPET.split("\n")[0]);
    // "the user pastes the policy": the fake tailnet now accepts the tags
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    st.allowed = ALL;
    writeFileSync(stateFile, JSON.stringify(st));
    t.stdin.write("\n");
    await new Promise((r) => setTimeout(r, 300));
    t.stdin.write("n\n");
    t.stdin.end();
    expect(await run).toBe(0);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).tags).toEqual(["tag:resolvroom", "tag:resolvroom-ask"]);
    expect(t.out()).toContain("Tags applied");
  }, 20000);

  it("--yes cannot wait for a policy edit: fails with instructions", async () => {
    const dir = tmp();
    const { bin } = fakeTailscale(dir, { tags: [], allowed: [] });
    const t = ctx(dir, bin);
    expect(await initCommand(["--yes", "--no-claude"], t.io, noClaude)).toBe(1);
    expect(t.out()).toContain("tagOwners");
  });

  it("permission problem suggests sudo instead of the policy", async () => {
    const dir = tmp();
    const { bin } = fakeTailscale(dir, { tags: [], allowed: ALL, denyPermission: true });
    const t = ctx(dir, bin);
    expect(await initCommand(["--yes", "--no-claude"], t.io, noClaude)).toBe(1);
    expect(t.out()).toContain("sudo tailscale set --advertise-tags=");
    expect(t.out()).not.toContain("tagOwners");
  });

  it("no Tailscale: stops with the install link", async () => {
    const dir = tmp();
    const t = ctx(dir, join(dir, "empty"), { env: { PATH: join(dir, "empty"), RESOLVROOM_HOME: join(dir, "home"), HOME: dir } });
    expect(await initCommand(["--yes"], t.io, noClaude)).toBe(1);
    expect(t.out()).toContain("tailscale.com/download");
  });

  it("calls the Claude Code installer when claude exists", async () => {
    const dir = tmp();
    const { bin } = fakeTailscale(dir, { tags: [], allowed: ALL });
    const claude = join(bin, "claude");
    writeFileSync(claude, '#!/bin/sh\necho "9.9.9 (Fake)"\n');
    chmodSync(claude, 0o755);
    let called: string[] | undefined;
    const t = ctx(dir, bin);
    await initCommand(["--yes"], t.io, { installClaude: async (a) => ((called = a), 0) });
    expect(called).toEqual(["--yes"]);
    expect(t.out()).toContain("claude-code (9.9.9 (Fake))");
  });
});

describe("service files", () => {
  const spec = { node: "/usr/bin/node", bin: "/home/u/.local/bin/resolvroom", workdir: "/srv/my app", agent: "claude-code", home: "/home/u/.resolvroom", path: "/usr/bin:/bin" };
  it("systemd unit has the right command, working dir, env and restart", () => {
    const u = systemdUnit(spec);
    expect(u).toContain('ExecStart=/usr/bin/node /home/u/.local/bin/resolvroom start --workdir "/srv/my app" --agent claude-code');
    expect(u).toContain("WorkingDirectory=/srv/my app");
    expect(u).toContain("Environment=RESOLVROOM_HOME=/home/u/.resolvroom");
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("WantedBy=default.target");
  });
  it("launchd plist escapes and keeps alive", () => {
    const p = launchdPlist({ ...spec, workdir: "/srv/a&b" });
    expect(p).toContain("<string>/srv/a&amp;b</string>");
    expect(p).toContain("<key>KeepAlive</key><true/>");
  });
  it("paths per platform", () => {
    expect(servicePaths("linux", "/h")?.file).toBe("/h/.config/systemd/user/resolvroom.service");
    expect(servicePaths("darwin", "/h")?.kind).toBe("launchd");
    expect(servicePaths("win32", "/h")).toBeNull();
    expect(existsSync("/")).toBe(true);
  });
});
