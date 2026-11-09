/**
 * A minimal MCP server on stdio with one tool, `approve`, used as Claude Code's `--permission-prompt-tool`.
 * It forwards every permission question to the runner over a private unix socket and returns the runner's
 * decision. No dependencies on purpose: it is spawned by `claude` for each run.
 *
 * Env: RR_ACCESS_SOCKET (socket path), RR_ACCESS_TOKEN (shared secret for this run).
 */
import { connect } from "node:net";
import { createInterface } from "node:readline";

const socketPath = process.env.RR_ACCESS_SOCKET ?? "";
const token = process.env.RR_ACCESS_TOKEN ?? "";

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

function send(m: unknown): void {
  process.stdout.write(`${JSON.stringify(m)}\n`);
}

function ask(toolName: string, input: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const deny = (message: string): void => resolve({ behavior: "deny", message });
    const sock = connect(socketPath);
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch {
          deny("invalid answer from Resolv Room");
        }
        sock.end();
      }
    });
    sock.on("error", () => deny("Resolv Room is not reachable; denied"));
    sock.on("close", () => deny("Resolv Room closed the connection; denied"));
    sock.write(`${JSON.stringify({ token, tool_name: toolName, input })}\n`);
  });
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let m: Msg;
  try {
    m = JSON.parse(line) as Msg;
  } catch {
    return;
  }
  if (m.id === undefined) return; // notifications
  switch (m.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "resolvroom-access", version: "0.1.0" },
        },
      });
      return;
    case "ping":
      send({ jsonrpc: "2.0", id: m.id, result: {} });
      return;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          tools: [
            {
              name: "approve",
              description: "Resolv Room permission check (asks the owner of this machine).",
              inputSchema: {
                type: "object",
                properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
                required: ["tool_name", "input"],
              },
            },
          ],
        },
      });
      return;
    case "tools/call": {
      const args = (m.params?.arguments ?? {}) as { tool_name?: unknown; input?: unknown };
      const id = m.id;
      void ask(String(args.tool_name ?? ""), args.input ?? {}).then((decision) =>
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } }),
      );
      return;
    }
    default:
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method ?? ""}` } });
  }
});
rl.on("close", () => process.exit(0));
