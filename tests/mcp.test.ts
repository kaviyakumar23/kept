import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSimulatedMcpWorkItems, McpWorkItemAdapter } from "../src/integrations/mcp.js";

/**
 * MCP integration tests — Kept as a DETERMINISTIC MCP client. These exercise a
 * real MCP client↔server round-trip (listTools + callTool) over an in-memory
 * transport, with no network or OAuth. The model is never in the loop: code
 * picks the tool and the arguments.
 */
describe("MCP work-item adapter", () => {
  it("creates issues over a real MCP client↔server round-trip", async () => {
    const wi = await createSimulatedMcpWorkItems({ startAt: 118 });
    expect(wi.system).toBe("linear");
    const a = await wi.createIssue({ title: "Fix SSO login" });
    const b = await wi.createIssue({ title: "Add CSV export" });
    expect(a.ref).toBe("PROJ-118");
    expect(b.ref).toBe("PROJ-119");
    expect(a.url).toContain("PROJ-118");
    await wi.close();
  });

  it("parses {ref,url} from structuredContent and respects the system label", async () => {
    const wi = await createSimulatedMcpWorkItems({ prefix: "ACME", startAt: 1001, system: "jira" });
    const a = await wi.createIssue({ title: "Investigate" });
    expect(a.ref).toBe("ACME-1001");
    expect(a.url).toContain("acme.atlassian.net");
    expect(wi.system).toBe("jira");
    await wi.close();
  });

  it("resolves the create-issue tool by heuristic when its name differs", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    server.registerTool(
      "createIssueViaApi",
      { description: "make an issue", inputSchema: { title: z.string() }, outputSchema: { identifier: z.string(), url: z.string() } },
      async ({ title }) => ({ content: [{ type: "text", text: title }], structuredContent: { identifier: "ZED-7", url: "https://x/ZED-7" } }),
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const wi = new McpWorkItemAdapter({ system: "linear", transport: () => ct }); // no toolName → heuristic
    const a = await wi.createIssue({ title: "hi" });
    expect(a.ref).toBe("ZED-7"); // parsed from structuredContent.identifier
    await wi.close();
  });

  it("throws a clear error when the server exposes no create-issue tool", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    server.registerTool("list_issues", { description: "list", outputSchema: { ok: z.boolean() } }, async () => ({ content: [], structuredContent: { ok: true } }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const wi = new McpWorkItemAdapter({ system: "linear", transport: () => ct });
    await expect(wi.createIssue({ title: "x" })).rejects.toThrow(/create-issue tool/i);
    await wi.close();
  });
});
