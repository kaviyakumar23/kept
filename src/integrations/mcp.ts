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

// Length-bounded so adversarial all-uppercase text can't trigger quadratic backtracking.
const REF_RE = /[A-Z][A-Z0-9]{0,63}-\d{1,9}/;
const URL_RE = /https?:\/\/[^\s"']{1,2048}/;
/** Cap text + traversal depth so a malicious/buggy tool result can't wedge the event loop or blow the stack. */
const MAX_PARSE_TEXT = 4096;
const MAX_PARSE_DEPTH = 6;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** Depth-first search for the first non-empty string under any of `keys` (depth-capped). */
function pickString(obj: Record<string, unknown> | undefined, keys: string[], depth = 0): string | undefined {
  if (!obj || depth > MAX_PARSE_DEPTH) return undefined;
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string" && val) return val;
  }
  for (const val of Object.values(obj)) {
    const nested = asRecord(val);
    if (nested) {
      const inner = pickString(nested, keys, depth + 1);
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
  const text = resultText(result).slice(0, MAX_PARSE_TEXT);
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

// --- W4: generic proof-read MCP client -------------------------------------
/** Structured result of an MCP tool call, or undefined when it returned no structuredContent. */
export type McpStructured = Record<string, unknown> | undefined;

/** A read-only MCP query surface. CODE picks the tool + args; the model is never in the loop. */
export interface McpQueryClient {
  query(name: string, args: Record<string, unknown>): Promise<McpStructured>;
  close(): Promise<void>;
}

/**
 * Generic read-only MCP client for Proof-of-Done reads (feature-flag state, status
 * page). Connect once, then `query(tool, args)` → callTool → error-check →
 * structuredContent. Same deterministic-client discipline as McpWorkItemAdapter: the
 * engine decides WHICH proof to read; this just transports the call.
 */
export class McpProofClient implements McpQueryClient {
  readonly label: string;
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;

  constructor(private readonly opts: { transport: () => Transport; clientName?: string; label?: string }) {
    this.label = opts.label ?? "mcp(proof)";
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

  async query(name: string, args: Record<string, unknown>): Promise<McpStructured> {
    const client = await this.ensureClient();
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    if ((result as { isError?: boolean }).isError) {
      throw new Error(`MCP tool "${name}" failed: ${resultText(result).slice(0, MAX_PARSE_TEXT).slice(0, 200)}`);
    }
    // Reuse the existing parse cap: only accept a shallow structured record.
    return asRecord((result as { structuredContent?: unknown }).structuredContent);
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
  }
}

/** Mutable state a simulated proof server reads at call time (mutate to model a toggle over time). */
export interface SimulatedProofState {
  /** flag key → its production state. Flip `enabled` to simulate an OFF→ON toggle. */
  flags: Record<string, { enabled: boolean; environment?: string }>;
  /** component name → its Statuspage health (defaults to "operational" when absent). */
  statuses: Record<string, { component_status: string }>;
}

/**
 * In-process simulated proof MCP server (LaunchDarkly `get_flag_state` + Atlassian
 * Statuspage `get_status_page`) wired to a real MCP client over an in-memory transport.
 * Mirrors createSimulatedMcpWorkItems: a REAL client↔server round-trip, no network/OAuth,
 * so the demo and hermetic tests exercise the actual MCP query path (these two sources
 * are honestly SIMULATED — GitHub Actions is the one genuine live proof source).
 */
export async function createSimulatedProofServer(
  state: SimulatedProofState = { flags: {}, statuses: {} },
): Promise<McpProofClient> {
  const server = new McpServer({ name: "kept-sim-proof", version: "0.1.0" });
  server.registerTool(
    "get_flag_state",
    {
      title: "Get feature-flag state",
      description: "Return whether a feature flag is enabled in an environment.",
      inputSchema: { flag_key: z.string(), environment: z.string().optional() },
      outputSchema: { enabled: z.boolean(), environment: z.string() },
    },
    async ({ flag_key, environment }) => {
      const st = state.flags[flag_key];
      const env = environment ?? st?.environment ?? "production";
      const enabled = st?.enabled ?? false;
      return {
        content: [{ type: "text", text: `flag ${flag_key} @ ${env}: ${enabled ? "ON" : "OFF"}` }],
        structuredContent: { enabled, environment: env },
      };
    },
  );
  server.registerTool(
    "get_status_page",
    {
      title: "Get status-page component health",
      description: "Return the operational status of a status-page component.",
      inputSchema: { component: z.string() },
      outputSchema: { component_status: z.string() },
    },
    async ({ component }) => {
      const component_status = state.statuses[component]?.component_status ?? "operational";
      return {
        content: [{ type: "text", text: `component ${component}: ${component_status}` }],
        structuredContent: { component_status },
      };
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpProofClient({ transport: () => clientTransport, label: "mcp(proof-sim)" });
  (client as unknown as { _server: McpServer })._server = server;
  return client;
}
