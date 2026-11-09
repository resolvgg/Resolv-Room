import { ControlClient, formatApproval } from "@resolvroom/daemon";
import type { PendingApproval } from "@resolvroom/daemon";
import { ConfigStore, resolveHome } from "@resolvroom/core";
import { LineReader, UsageError, opts, sleep } from "./util.js";
import type { Io } from "./util.js";

const client = (io: Io): ControlClient => new ControlClient(new ConfigStore(resolveHome(io.env)).socketPath);

/** `pair` (this machine shows a code) or `pair <peer> <code>` (this machine redeems it). */
export async function pairCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = opts(args, { endpoint: { type: "string" }, "reply-endpoint": { type: "string" }, cancel: { type: "boolean" } });
  const c = client(io);
  if (values.cancel) {
    await c.pairCancel();
    io.out("Pairing window closed.\n");
    return 0;
  }
  if (positionals.length === 0) {
    const { name } = await c.status();
    const { code, expiresAt } = await c.pairStart();
    io.out(
      [
        "",
        `  Pairing code:  ${code}`,
        "",
        "  Valid for 5 minutes, single use, 3 attempts.",
        "  On the OTHER machine run:",
        `    resolvroom pair ${name} ${code}`,
        "",
        `Waiting (until ${expiresAt})... Ctrl+C to cancel.`,
        "",
      ].join("\n"),
    );
    for (;;) {
      await sleep(500);
      const st = await c.pairStatus();
      if (st.state === "paired") {
        io.out(`✔ Paired with ${st.peer}. It can consult this machine in ask mode, read-only: every request still needs your OK.\n`);
        io.out(`  To change what it can do: resolvroom peer allow ${st.peer} --mode ...\n`);
        return 0;
      }
      if (st.state === "expired") {
        io.err("The code expired. Run `resolvroom pair` again.\n");
        return 1;
      }
      if (st.state === "locked") {
        io.err("Too many wrong codes: the pairing window was closed. Run `resolvroom pair` again.\n");
        return 1;
      }
      if (st.state === "idle") return 1;
    }
  }
  if (positionals.length === 2) {
    const [peer, code] = positionals as [string, string];
    await c.pairJoin({
      peer,
      code,
      ...(values.endpoint ? { endpoint: values.endpoint } : {}),
      ...(values["reply-endpoint"] ? { reply_endpoint: values["reply-endpoint"] } : {}),
    });
    io.out(`✔ Paired with ${peer}. It is on your list in ask mode, read-only.\n  Test:  resolvroom consult ${peer} "ping"\n`);
    return 0;
  }
  throw new UsageError("usage: resolvroom pair            (show a code here)\n       resolvroom pair <peer> <code>   (redeem a code shown on the other machine)");
}

function show(a: PendingApproval): string {
  return formatApproval({
    peer: a.peer, sessionId: a.session_id, goal: a.goal, proposal: a.proposal, mode: a.mode,
    capabilities: { read: false, write: false, exec: false, network: false }, access: a.access, timeoutS: a.timeout_s,
    ...(a.action ? { action: a.action } : {}),
    signal: new AbortController().signal,
  });
}

/** `approvals` lists, `approvals --watch` asks about each new request, `approve <id>` / `deny <id>` answer one. */
export async function approvalsCommand(args: string[], io: Io, mode: "list" | "allow" | "deny" = "list"): Promise<number> {
  const { values, positionals } = opts(args, { watch: { type: "boolean" } });
  const c = client(io);
  if (mode !== "list") {
    const id = positionals[0];
    if (!id) throw new UsageError(`usage: resolvroom ${mode === "allow" ? "approve" : "deny"} <id>`);
    await c.answerApproval(id, mode);
    io.out(mode === "allow" ? "Allowed.\n" : "Denied.\n");
    return 0;
  }
  const first = await c.approvals();
  if (!values.watch) {
    if (first.length === 0) io.out("No requests waiting.\n");
    for (const a of first) io.out(`${show(a)}\n  id: ${a.id}   ->  resolvroom approve ${a.id}   |   resolvroom deny ${a.id}\n`);
    return 0;
  }
  io.out("Watching for requests. Ctrl+C to stop.\n");
  const reader = new LineReader(io.stdin);
  const seen = new Set<string>();
  try {
    for (;;) {
      for (const a of await c.approvals()) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        io.out(`${show(a)}\n`);
        const yes = await reader.yesNo(io, "Allow?", false);
        await c.answerApproval(a.id, yes ? "allow" : "deny").catch(() => io.out("(it already timed out)\n"));
      }
      await sleep(1000);
    }
  } finally {
    reader.close();
  }
}
