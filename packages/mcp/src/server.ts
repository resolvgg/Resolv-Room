import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsultOutcome } from "@resolvroom/core";
import { resolve } from "node:path";
import type { ConsultRequest, PeerSummary, SendOutcome, SendRequest } from "@resolvroom/daemon";
import { roomInstructions } from "./room.js";

/** What the MCP server needs from the local daemon. `ControlClient` implements it. */
export interface DaemonApi {
  consult(req: ConsultRequest, signal?: AbortSignal): Promise<ConsultOutcome>;
  peers(): Promise<PeerSummary[]>;
  send?(req: SendRequest): Promise<SendOutcome>;
}

export function formatSend(o: SendOutcome): string {
  if (o.status === "error") return `Sending to ${o.peer} failed: ${o.message}`;
  const sk = o.skipped;
  const notes = [
    sk.secrets.length ? `${sk.secrets.length} secret file(s) left out (${sk.secrets.slice(0, 5).join(", ")}${sk.secrets.length > 5 ? ", …" : ""})` : "",
    sk.excluded ? `${sk.excluded} dependency/build/.git folder(s) left out` : "",
    sk.links ? `${sk.links} symlink(s) skipped` : "",
  ].filter(Boolean);
  const tail = notes.length ? `\nNot sent: ${notes.join("; ")}.` : "";
  if (o.status === "declined") return `${o.peer} did not accept the files: ${o.message}.${tail}`;
  return `Sent ${o.files} file(s) to ${o.peer}. They are in ${o.dest} on that machine; a consult to ${o.peer} can read them.${tail}`;
}

export function formatOutcome(o: ConsultOutcome): string {
  const where = o.effective ? ` (applied there: ${o.effective.mode} mode, ${caps(o.effective.capabilities)})` : "";
  const head = `Consult with ${o.peer}: ${o.status}${where}`;
  return `${head}\n\n${o.summary}`;
}

function caps(c: { read: boolean; write: boolean; exec: boolean; network: boolean }): string {
  const on = (Object.keys(c) as Array<keyof typeof c>).filter((k) => c[k]);
  return on.length > 0 ? on.join("+") : "no tools";
}

const OK_STATUSES = new Set<ConsultOutcome["status"]>(["solved", "partial", "unsolved", "declined", "rejected"]);

export function createMcpServer(api: DaemonApi, version = "0.0.0"): McpServer {
  const server = new McpServer({ name: "resolvroom", version });

  server.registerTool(
    "consult",
    {
      title: "Consult an agent on another machine",
      description:
        "Send your proposal to the agent on another machine (a Resolv Room peer) and wait for its answer. " +
        "Use it after you already worked on the problem. The other side may ask its human for approval first, so it can take a while. " +
        "Never include secrets in the proposal.",
      inputSchema: {
        peer: z.string().min(1).describe("Name of the peer (see the `peers` tool)."),
        goal: z.string().min(1).max(4000).describe("What the user asked for, in one or two sentences."),
        proposal: z.string().min(1).max(200000).describe("Your findings and recommended solution, self-contained, plus what you want checked."),
        ask_only: z
          .boolean()
          .optional()
          .describe("Force the other side to ask its human before doing anything, even if it would run unattended."),
        max_minutes: z.number().int().min(1).max(60).optional().describe("Give up after this many minutes. Default 5."),
      },
    },
    async ({ peer, goal, proposal, ask_only, max_minutes }, extra) => {
      try {
        const outcome = await api.consult(
          {
            peer,
            goal,
            proposal,
            ...(ask_only ? { mode_cap: "ask" as const } : {}),
            ...(max_minutes ? { limits: { max_duration_s: max_minutes * 60 } } : {}),
          },
          extra.signal,
        );
        return { content: [{ type: "text" as const, text: formatOutcome(outcome) }], isError: !OK_STATUSES.has(outcome.status) };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Consult failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  if (api.send) {
    const send = api.send.bind(api);
    server.registerTool(
      "send_files",
      {
        title: "Send files to another machine",
        description:
          "Copy files or folders from this machine to a Resolv Room peer. The owner of that machine must accept; the files land in its " +
          "Resolv Room inbox (never elsewhere) and a later consult to that peer can read them. Secrets (.env, keys, ~/.ssh…) are always " +
          "left out; node_modules/build folders and .git are left out unless asked.",
        inputSchema: {
          peer: z.string().min(1).describe("Name of the peer (see the `peers` tool)."),
          paths: z.array(z.string().min(1)).min(1).max(50).describe("Files or folders to send (absolute, or relative to the current folder)."),
          message: z.string().max(2000).optional().describe("Short note shown to the receiving human."),
          include_git: z.boolean().optional().describe("Also send .git folders."),
          include_deps: z.boolean().optional().describe("Also send node_modules, build output and caches."),
        },
      },
      async ({ peer, paths, message, include_git, include_deps }) => {
        try {
          const out = await send({
            peer,
            paths: paths.map((p) => resolve(process.cwd(), p)),
            ...(message ? { message } : {}),
            ...(include_git ? { include_git } : {}),
            ...(include_deps ? { include_deps } : {}),
          });
          return { content: [{ type: "text" as const, text: formatSend(out) }], isError: out.status === "error" };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Sending failed: ${(err as Error).message}` }], isError: true };
        }
      },
    );
  }

  server.registerTool(
    "peers",
    {
      title: "List peers you can consult",
      description: "Lists the machines that are on this daemon's allowlist.",
      inputSchema: {},
    },
    async () => {
      try {
        const peers = await api.peers();
        const text =
          peers.length === 0
            ? "No peers yet. Add one with `resolvroom peer allow <name>` (on both machines)."
            : peers.map((p) => `- ${p.peer} (their access to you: ${p.mode} mode)`).join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Could not list peers: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerPrompt(
    "room",
    {
      title: "Room: solve a request with a second opinion from another machine",
      description: "Starts the user's request, builds a proposal and consults the agent on another machine.",
      argsSchema: {
        request: z.string().describe("What you want solved. You can start it with the peer name."),
        peer: z.string().optional().describe("Peer to consult (optional)."),
      },
    },
    ({ request, peer }) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: roomInstructions(request, peer) } }],
    }),
  );

  return server;
}
