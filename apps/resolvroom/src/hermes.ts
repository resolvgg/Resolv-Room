import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { peerSkillMarkdown, roomSkillMarkdown } from "@resolvroom/mcp";
import { runProcess } from "@resolvroom/runner";
import { confirm, opts } from "./util.js";
import type { Io } from "./util.js";

export function hermesHome(io: Io): string {
  return io.env.HERMES_HOME && io.env.HERMES_HOME.length > 0 ? io.env.HERMES_HOME : join(io.env.HOME ?? homedir(), ".hermes");
}

/** `hermes mcp add` arguments. --env takes a list, so it goes before --command; --args must be last. */
export function hermesMcpAddArgs(node: string, bin: string, env: NodeJS.ProcessEnv): string[] {
  const a = ["mcp", "add", "resolvroom"];
  if (env.RESOLVROOM_HOME) a.push("--env", `RESOLVROOM_HOME=${env.RESOLVROOM_HOME}`);
  a.push("--command", node, "--args", bin, "mcp");
  return a;
}

/** Registers the MCP server in Hermes Agent and installs a `room` skill, so `/room <request>` works there. */
export async function installHermesCommand(args: string[], io: Io): Promise<number> {
  const { values } = opts(args, { yes: { type: "boolean" }, print: { type: "boolean" } });
  const skillFile = join(hermesHome(io), "skills", "resolvroom", "room", "SKILL.md");
  const peerSkill = join(hermesHome(io), "skills", "resolvroom", "resolvroom", "SKILL.md");
  const wanted = roomSkillMarkdown();
  const bin = realpathSync(process.argv[1] ?? "");
  const mcpArgs = hermesMcpAddArgs(process.execPath, bin, io.env);

  io.out(`This will:\n  1. write the /room skill to ${skillFile}\n  2. write the resolvroom skill (for "migrate/send/ask the other machine") to ${peerSkill}\n  3. run: hermes ${mcpArgs.join(" ")}\n`);
  if (values.print) {
    io.out(`\n--- ${skillFile} ---\n${wanted}`);
    return 0;
  }
  if (!values.yes && !(await confirm(io, "Proceed?"))) {
    io.out("Nothing changed. (Use --yes to skip this question, or --print to see the skill.)\n");
    return 1;
  }
  const current = existsSync(skillFile) ? readFileSync(skillFile, "utf8") : undefined;
  if (current === wanted) io.out("• /room skill already up to date\n");
  else {
    mkdirSync(dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, wanted);
    io.out(`✔ wrote ${skillFile}\n`);
  }
  const peerCurrent = existsSync(peerSkill) ? readFileSync(peerSkill, "utf8") : undefined;
  if (peerCurrent !== peerSkillMarkdown()) {
    mkdirSync(dirname(peerSkill), { recursive: true });
    writeFileSync(peerSkill, peerSkillMarkdown());
    io.out(`✔ wrote ${peerSkill}\n`);
  } else io.out("• resolvroom skill already up to date\n");
  try {
    const list = await runProcess("hermes", ["mcp", "list"], "", 30_000, { env: io.env });
    if (list.code === 0 && /^\s*resolvroom\s/m.test(list.stdout)) {
      io.out('• MCP server "resolvroom" is already registered in Hermes\n');
    } else {
      // `hermes mcp add` connects to the server and asks to enable its tools (and, if the MCP extra is missing,
      // whether to save anyway): answer yes.
      const add = await runProcess("hermes", mcpArgs, "y\ny\ny\n", 90_000, { env: io.env });
      if (add.code !== 0 || !/Saved 'resolvroom'/.test(add.stdout + add.stderr)) {
        throw new Error((add.stderr || add.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${add.code}`);
      }
      io.out('✔ registered the MCP server "resolvroom" in Hermes\n');
    }
  } catch (err) {
    io.err(`Could not register it with the hermes CLI (${(err as Error).message}). Do it yourself:\n  hermes ${mcpArgs.join(" ")}\n`);
    return 1;
  }
  io.out("Start a new Hermes session, then try:  /room <what you want solved>\n");
  return 0;
}
