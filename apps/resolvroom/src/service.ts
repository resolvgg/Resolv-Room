import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runProcess } from "@resolvroom/runner";
import { UsageError, confirm, opts, workdirProblem } from "./util.js";
import type { Io } from "./util.js";

export interface ServiceSpec {
  node: string;
  bin: string;
  workdir: string;
  agent?: string;
  home?: string;
  path?: string;
}

const q = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);

export function systemdUnit(s: ServiceSpec): string {
  const args = ["start", "--workdir", s.workdir, ...(s.agent ? ["--agent", s.agent] : [])].map(q).join(" ");
  return [
    "[Unit]",
    "Description=Resolv Room daemon",
    "After=network-online.target tailscaled.service",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${q(s.node)} ${q(s.bin)} ${args}`,
    `WorkingDirectory=${s.workdir}`,
    ...(s.home ? [`Environment=${q(`RESOLVROOM_HOME=${s.home}`)}`] : []),
    ...(s.path ? [`Environment=${q(`PATH=${s.path}`)}`] : []),
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const xml = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(s: ServiceSpec, label = "chat.resolv.resolvroom"): string {
  const args = [s.node, s.bin, "start", "--workdir", s.workdir, ...(s.agent ? ["--agent", s.agent] : [])];
  const env = { ...(s.home ? { RESOLVROOM_HOME: s.home } : {}), ...(s.path ? { PATH: s.path } : {}) };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${xml(label)}</string>`,
    `  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>`,
    `  <key>WorkingDirectory</key><string>${xml(s.workdir)}</string>`,
    Object.keys(env).length
      ? `  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>`
      : "",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    `  <key>StandardOutPath</key><string>${xml(join(s.home ?? join(homedir(), ".resolvroom"), "daemon.log"))}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(join(s.home ?? join(homedir(), ".resolvroom"), "daemon.log"))}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
}

export function servicePaths(platform: NodeJS.Platform, home = homedir()): { file: string; kind: "systemd" | "launchd" } | null {
  if (platform === "linux") return { file: join(home, ".config", "systemd", "user", "resolvroom.service"), kind: "systemd" };
  if (platform === "darwin") return { file: join(home, "Library", "LaunchAgents", "chat.resolv.resolvroom.plist"), kind: "launchd" };
  return null;
}

export async function serviceCommand(args: string[], io: Io): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "install" && sub !== "uninstall") throw new UsageError("usage: resolvroom service install|uninstall [--workdir <dir>] [--agent claude-code|mock] [--yes]");
  const target = servicePaths(process.platform, io.env.HOME ?? homedir());
  if (!target) throw new UsageError("background service is supported on Linux (systemd --user) and macOS (launchd) only");
  const { values } = opts(rest, { workdir: { type: "string" }, agent: { type: "string" }, yes: { type: "boolean" } });

  if (sub === "uninstall") {
    if (!existsSync(target.file)) {
      io.out("No service installed.\n");
      return 0;
    }
    if (target.kind === "systemd") await runProcess("systemctl", ["--user", "disable", "--now", "resolvroom.service"], "", 20_000, { env: io.env }).catch(() => undefined);
    else await runProcess("launchctl", ["unload", target.file], "", 20_000, { env: io.env }).catch(() => undefined);
    rmSync(target.file);
    io.out(`✔ removed ${target.file}\n`);
    return 0;
  }

  const workdirIssue = workdirProblem(resolve(io.cwd, values.workdir ?? "."), io.env.HOME ?? homedir());
  if (workdirIssue && values.agent !== "mock") throw new UsageError(`--workdir: ${workdirIssue}`);
  const spec: ServiceSpec = {
    node: process.execPath,
    bin: resolve(io.cwd, process.argv[1] ?? ""),
    workdir: resolve(io.cwd, values.workdir ?? "."),
    ...(values.agent ? { agent: values.agent } : {}),
    ...(io.env.RESOLVROOM_HOME ? { home: io.env.RESOLVROOM_HOME } : {}),
    ...(io.env.PATH ? { path: io.env.PATH } : {}),
  };
  io.out(
    `This will install a background service that runs the daemon at login/boot:\n  file:    ${target.file}\n  runs:    resolvroom start --workdir ${spec.workdir}\n` +
      "  note:    with no terminal, requests that need approval wait in a queue; answer them with `resolvroom approvals`.\n",
  );
  if (!values.yes && !(await confirm(io, "Install it?"))) {
    io.out("Nothing changed.\n");
    return 1;
  }
  mkdirSync(dirname(target.file), { recursive: true });
  writeFileSync(target.file, target.kind === "systemd" ? systemdUnit(spec) : launchdPlist(spec));
  io.out(`✔ wrote ${target.file}\n`);
  const run = async (cmd: string, a: string[]): Promise<boolean> => {
    try {
      const r = await runProcess(cmd, a, "", 30_000, { env: io.env });
      if (r.code !== 0) io.err(`  ${cmd} ${a.join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}\n`);
      return r.code === 0;
    } catch (err) {
      io.err(`  could not run ${cmd}: ${(err as Error).message}\n`);
      return false;
    }
  };
  if (target.kind === "systemd") {
    const ok = (await run("systemctl", ["--user", "daemon-reload"])) && (await run("systemctl", ["--user", "enable", "--now", "resolvroom.service"]));
    if (!ok) {
      io.err("Start it yourself:  systemctl --user daemon-reload && systemctl --user enable --now resolvroom.service\n");
      return 1;
    }
    io.out("✔ service enabled and started (systemctl --user status resolvroom)\n");
    io.out("  On a server, keep it running after you log out with:  loginctl enable-linger $USER\n");
  } else {
    if (!(await run("launchctl", ["load", "-w", target.file]))) {
      io.err(`Start it yourself:  launchctl load -w ${target.file}\n`);
      return 1;
    }
    io.out("✔ service loaded (logs in ~/.resolvroom/daemon.log)\n");
  }
  return 0;
}
