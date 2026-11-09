import { chmodSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { runProcess } from "@resolvroom/runner";
import { restartService } from "./service.js";
import { opts } from "./util.js";
import type { Io } from "./util.js";

/** The git checkout this command runs from: <src>/apps/resolvroom/dist/bin.js -> <src>. */
export function sourceDir(binPath: string): string {
  return resolve(dirname(realpathSync(binPath)), "..", "..", "..");
}

/**
 * Pulls the latest version into the checkout the command runs from, rebuilds it and restarts the background
 * service. Your config, peers and agent registrations are left alone.
 */
export async function updateCommand(args: string[], io: Io, binPath = process.argv[1] ?? ""): Promise<number> {
  const { values } = opts(args, { force: { type: "boolean" }, "no-restart": { type: "boolean" } });
  const dir = sourceDir(binPath);
  if (!existsSync(join(dir, ".git"))) {
    io.err(`${dir} is not a git checkout. Reinstall with:\n  curl -fsSL https://raw.githubusercontent.com/resolvgg/Resolv-Room/main/install.sh | sh\n`);
    return 1;
  }
  const home = io.env.HOME ?? homedir();
  // Use the installer's corepack shim when there is no pnpm on PATH.
  const shim = join(home, ".resolvroom", ".shim");
  const env = { ...io.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", PATH: existsSync(shim) ? `${shim}${delimiter}${io.env.PATH ?? ""}` : io.env.PATH };
  const run = async (cmd: string, a: string[], timeout = 120_000): Promise<string> => {
    const r = await runProcess(cmd, a, "", timeout, { cwd: dir, env });
    if (r.code !== 0) throw new Error(`${cmd} ${a.join(" ")} failed:\n${(r.stderr || r.stdout).trim().split("\n").slice(-15).join("\n")}`);
    return r.stdout.trim();
  };

  try {
    const before = await run("git", ["rev-parse", "HEAD"]);
    let branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD") branch = "main";
    io.out(`Checking for updates (${branch})...\n`);
    await run("git", ["fetch", "--quiet", "origin", branch]);
    const after = await run("git", ["rev-parse", "FETCH_HEAD"]);
    if (after === before && !values.force) {
      io.out(`✔ Already up to date (${before.slice(0, 7)}).\n`);
      return 0;
    }
    const changes = after === before ? "" : await run("git", ["log", "--oneline", "--no-decorate", `${before}..${after}`]).catch(() => "");
    await run("git", ["reset", "--quiet", "--hard", after]);
    io.out("Installing dependencies and building (a minute or two)...\n");
    let pnpm = "pnpm";
    try {
      await run("pnpm", ["--version"], 60_000);
    } catch {
      pnpm = "corepack";
    }
    const p = (a: string[]): string[] => (pnpm === "corepack" ? ["pnpm", ...a] : a);
    await run(pnpm, p(["install", "--frozen-lockfile"]), 600_000);
    await run(pnpm, p(["-r", "build"]), 600_000);
    const bin = join(dir, "apps", "resolvroom", "dist", "bin.js");
    if (existsSync(bin)) chmodSync(bin, 0o755);
    io.out(`✔ Updated ${before.slice(0, 7)} -> ${after.slice(0, 7)}\n`);
    if (changes) io.out(`${changes.split("\n").slice(0, 15).map((l) => `  ${l}`).join("\n")}\n`);
    // Refresh the agent integrations already installed (new skills, command text), using the NEW build.
    const claudeDir = io.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    const hermesDir = io.env.HERMES_HOME || join(home, ".hermes");
    for (const [cmd, marker] of [["install-claude", join(claudeDir, "commands", "room.md")], ["install-hermes", join(hermesDir, "skills", "resolvroom", "room", "SKILL.md")]] as const) {
      if (!existsSync(marker) || !existsSync(bin)) continue;
      const r = await runProcess(process.execPath, [bin, cmd, "--yes"], "", 120_000, { env });
      io.out(r.code === 0 ? `✔ Refreshed ${cmd === "install-claude" ? "Claude Code" : "Hermes"} integration\n` : `• Could not refresh ${cmd}: run  resolvroom ${cmd}\n`);
    }
  } catch (err) {
    io.err(`✖ ${(err as Error).message}\n  If the build is broken, reinstall with the curl command from the README.\n`);
    return 1;
  }

  if (!values["no-restart"]) await restartService(io);
  return 0;
}
