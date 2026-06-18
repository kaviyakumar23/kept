/**
 * MCP work-item adapter — satisfies the hackathon's "MCP server integration"
 * requirement while preserving Kept's core invariant: the model interprets
 * language; CODE controls state and actions.
 *
 * Kept acts as a DETERMINISTIC MCP client. The engine decides to create a work
 * item (downstream of a passed Gate-1 guard), and only then does this adapter
 * call a specific MCP tool with computed arguments. The LLM never selects the
 * tool — MCP is a governed action transport, not an agent free-for-all.
 *
 *   - Real servers: Linear (https://mcp.linear.app/mcp) and Atlassian/Jira
 *     (https://mcp.atlassian.com/v1/mcp) — both streamable-HTTP + OAuth/Bearer.
 *   - Offline: an in-process simulated MCP server over an in-memory transport, so
 *     the demo and the hermetic tests exercise a REAL MCP client↔server round
 *     trip (listTools + callTool) with no network or OAuth.
 *
 * The hosted servers' exact tool names and argument/result schemas aren't pinned
 * in their public docs and evolve over time, so tool resolution, argument
 * building, and result parsing are all configurable, with resilient defaults.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { WorkItemAdapter, CreateIssueInput, CreatedWorkItem } from "./linear.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

export interface McpWorkItemOptions {
  system: "linear" | "jira";
  /** Short label for logs, e.g. "mcp(linear)". */
  label?: string;
  /** Creates the transport on first use (memoized). */
  transport: () => Transport;
  /** Explicit create-issue tool name; otherwise resolved by heuristic from listTools(). */
  toolName?: string;
  /** Maps an obligation's create input to the tool's arguments. */
  buildArguments?: (input: CreateIssueInput) => Record<string, unknown>;
  /** Parses the tool result into a {ref,url}. */
  parseResult?: (result: ToolResult) => CreatedWorkItem;
  /** Client identity reported to the server. */
  clientName?: string;
}

const REF_RE = /[A-Z][A-Z0-9]*-\d+/;
const URL_RE = /https?:\/\/[^\s"']+/;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** Depth-first search for the first non-empty string under any of `keys`. */
function pickString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string" && val) return val;
  }
  for (const val of Object.values(obj)) {
    const nested = asRecord(val);
    if (nested) {
      const inner = pickString(nested, keys);
      if (inner) return inner;
    }
  }
  return undefined;
}

function resultText(result: ToolResult): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/** Default {ref,url} extraction: prefer structuredContent, fall back to scanning text. */
function defaultParse(result: ToolResult): CreatedWorkItem {
  const sc = asRecord((result as { structuredContent?: unknown }).structuredContent);
  const text = resultText(result);
  const ref = pickString(sc, ["ref", "identifier", "key", "issueKey", "id"]) ?? text.match(REF_RE)?.[0];
  const url = pickString(sc, ["url", "permalink", "link", "webUrl", "self"]) ?? text.match(URL_RE)?.[0];
  if (!ref) throw new Error(`MCP create-issue returned no parseable issue ref (text: ${text.slice(0, 160)})`);
  return { ref, url: url ?? "" };
}

export class McpWorkItemAdapter implements WorkItemAdapter {
  readonly system: "linear" | "jira";
  readonly label: string;
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private toolNameResolved: string | undefined;

  constructor(private readonly opts: McpWorkItemOptions) {
    this.system = opts.system;
    this.label = opts.label ?? `mcp(${opts.system})`;
    this.toolNameResolved = opts.toolName;
  }

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: this.opts.clientName ?? "kept", version: "0.1.0" });
        await client.connect(this.opts.transport());
        this.client = client;
        return client;
      })();
    }
    return this.connecting;
  }

  /** Resolve the create-issue tool: explicit name, else a create+issue heuristic over listTools(). */
  private async resolveToolName(client: Client): Promise<string> {
    if (this.toolNameResolved) return this.toolNameResolved;
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const chosen = names.find((n) => /create/i.test(n) && /issue/i.test(n)) ?? names.find((n) => /create/i.test(n));
    if (!chosen) throw new Error(`No create-issue tool found on the MCP server. Available tools: ${names.join(", ") || "(none)"}`);
    this.toolNameResolved = chosen;
    return chosen;
  }

  async createIssue(input: CreateIssueInput): Promise<CreatedWorkItem> {
    const client = await this.ensureClient();
    const name = await this.resolveToolName(client);
    const args = this.opts.buildArguments
      ? this.opts.buildArguments(input)
      : { title: input.title, ...(input.description ? { description: input.description } : {}) };
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    if ((result as { isError?: boolean }).isError) {
      throw new Error(`MCP tool "${name}" failed: ${resultText(result).slice(0, 200)}`);
    }
    return (this.opts.parseResult ?? defaultParse)(result);
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
  }

  /** Linear's hosted MCP server (streamable HTTP + Bearer token / OAuth). */
  static linear(opts: { token: string; url?: string; teamId?: string; toolName?: string }): McpWorkItemAdapter {
    const url = new URL(opts.url ?? "https://mcp.linear.app/mcp");
    return new McpWorkItemAdapter({
      system: "linear",
      label: "mcp(linear)",
      transport: () => new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${opts.token}` } } }),
      toolName: opts.toolName,
      buildArguments: (input) => ({
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(opts.teamId ? { team: opts.teamId, teamId: opts.teamId } : {}),
      }),
    });
  }

  /** Atlassian's hosted Remote MCP server for Jira (streamable HTTP + OAuth/Bearer). */
  static atlassian(opts: { token: string; url?: string; cloudId?: string; projectKey?: string; toolName?: string }): McpWorkItemAdapter {
    const url = new URL(opts.url ?? "https://mcp.atlassian.com/v1/mcp");
    return new McpWorkItemAdapter({
      system: "jira",
      label: "mcp(atlassian)",
      transport: () => new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${opts.token}` } } }),
      toolName: opts.toolName,
      buildArguments: (input) => ({
        summary: input.title,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(opts.projectKey ? { projectKey: opts.projectKey, project: opts.projectKey } : {}),
        ...(opts.cloudId ? { cloudId: opts.cloudId } : {}),
      }),
    });
  }
}

/**
 * In-process simulated MCP server + a client adapter wired to it over an
 * in-memory transport. Exercises a REAL MCP round-trip (listTools + callTool)
 * with zero network/OAuth, so the MCP integration is genuinely tested and the
 * demo actually runs over MCP — not a mock of it.
 */
export async function createSimulatedMcpWorkItems(
  opts: { startAt?: number; prefix?: string; system?: "linear" | "jira"; toolName?: string } = {},
): Promise<McpWorkItemAdapter> {
  const prefix = opts.prefix ?? "PROJ";
  const system = opts.system ?? "linear";
  const toolName = opts.toolName ?? "create_issue";
  let next = opts.startAt ?? 118;

  const server = new McpServer({ name: "kept-sim-workitems", version: "0.1.0" });
  server.registerTool(
    toolName,
    {
      title: "Create a work item",
      description: "Create an issue and return its identifier and URL.",
      inputSchema: { title: z.string(), description: z.string().optional() },
      outputSchema: { ref: z.string(), url: z.string() },
    },
    async ({ title }) => {
      const ref = `${prefix}-${next++}`;
      const url = system === "jira" ? `https://acme.atlassian.net/browse/${ref}` : `https://linear.app/acme/issue/${ref}`;
      return { content: [{ type: "text", text: `Created ${ref}: ${title}` }], structuredContent: { ref, url } };
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const adapter = new McpWorkItemAdapter({ system, label: "mcp(simulated)", transport: () => clientTransport, toolName });
  // Keep the server reachable for the lifetime of the adapter (and for cleanup).
  (adapter as unknown as { _server: McpServer })._server = server;
  return adapter;
}
