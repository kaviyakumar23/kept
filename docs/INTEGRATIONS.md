# Kept — Proof-of-Done integrations

Kept verifies real availability from proof it gathers (Proof-of-Done). There are **five**
proof sources. Each is a REAL integration: it makes actual API/MCP calls and returns only
**derived structured facts** (zero-copy — never a raw body). When a source's credentials are
**not** configured, the collector transparently routes that read to an in-process **simulated
MCP proof server**, so `npm run demo` and the hermetic tests run offline with no credentials.

> Honesty framing (CLAUDE.md invariant #7): Slack is the live surface; GitHub Actions is the
> always-live proof source. LaunchDarkly, Statuspage, Jira, and Linear are now **genuine**
> integrations too — each upgrades from simulated to live the moment you add its credentials.
> The agent only ever *proposes* structured evidence; `assessFulfillment` + the human gate
> decide (invariant #1).

## How real-vs-simulated selection works

Selection happens in `src/integrations/proofSources.ts` (`buildProofCollector`), mirroring the
work-item precedence in `src/server/index.ts`:

- For each source, if its credentials are present in config it uses its **real adapter**;
  otherwise that read is routed to the **simulated** proof server.
- A configured adapter that errors at runtime (network/HTTP) returns `undefined` → the
  collector proposes **no** evidence for that source (a missing proof is never a negative
  proof). It does **not** fall back to fake data once you've connected the real source.
- If **nothing** is configured (no real source, no targets file), production runs with **no**
  proof step — exactly as before this feature.

Which target Kept reads for an obligation is decided by CODE, not the model:

- **Jira / Linear issue status** is derived automatically from the obligation's linked work
  item (`work_item.system` + `work_item.ref`) — no extra config once Jira/Linear is connected.
- **Flag / Statuspage component / CI run** targets come from an optional JSON file
  (`KEPT_PROOF_TARGETS_FILE`) mapping `subject_canonical` → `{ flag, status, ci }`, e.g.:

  ```json
  {
    "SSO_LOGIN_BUG": {
      "flag":   { "key": "sso_login", "environment": "production" },
      "status": { "component": "8kp1q2r3s4t5" },
      "ci":     { "owner": "acme", "repo": "app", "runId": 123456789 }
    }
  }
  ```

The boot log prints `proof=live(<sources>)`, `proof=simulated`, or `proof=off`.

---

## GitHub Actions — CI run conclusion (REST, always-live) · MCP-shaped

Reads a workflow run's `conclusion` (`success` / `failure` / …). Reference adapter for all the
others: `src/integrations/githubActions.ts`.

| Env var | Required | Where to get it |
| --- | --- | --- |
| `GITHUB_TOKEN` | for live CI proof | A GitHub PAT (fine-grained or classic) with **Actions: read** on the repo. github.com → Settings → Developer settings → Personal access tokens. |

No token → CI proof is simply skipped.

---

## LaunchDarkly — feature-flag production state (REST)

Reads a flag's `environments.<env>.on`. This powers the **flag-OFF blocking negative**: the
ticket can be Done and the code deployed, but if the flag is OFF the capability isn't reachable,
so Kept blocks the close. Adapter: `src/integrations/launchDarkly.ts`. Endpoint:
`GET /api/v2/flags/{project}/{flag}?env={env}`.

| Env var | Required | Where to get it |
| --- | --- | --- |
| `LAUNCHDARKLY_API_TOKEN` | yes | LaunchDarkly → **Account settings → Authorization → Access tokens**. A read-only token is sufficient. Sent as the raw `Authorization` header (no `Bearer`). |
| `LAUNCHDARKLY_PROJECT_KEY` | yes | LaunchDarkly → Projects (e.g. `default`). |
| `LAUNCHDARKLY_ENVIRONMENT` | no (default `production`) | The environment **key** to read `on` from. |
| `LAUNCHDARKLY_BASE_URL` | no | Override for federal/self-hosted; defaults to `https://app.launchdarkly.com`. |

---

## Atlassian Statuspage — component operational health (REST)

Reads a component's `status` (`operational` / `degraded_performance` / …). Adapter:
`src/integrations/statuspage.ts`. Endpoint: `GET /v1/pages/{page}/components/{id}`.

| Env var | Required | Where to get it |
| --- | --- | --- |
| `STATUSPAGE_API_KEY` | yes | Statuspage → **Your account → API info → API key**. Sent as `Authorization: OAuth <key>`. |
| `STATUSPAGE_PAGE_ID` | yes | Statuspage → API info (the Page ID). |
| `STATUSPAGE_BASE_URL` | no | Defaults to `https://api.statuspage.io`. |

The proof target's `component` value is the **component id** (from the components API / URL).

---

## Jira — issue status (MCP-preferred, REST fallback)

Reads the linked issue's status, normalizing any Jira **"done" status category** to `Done`
(so reconciliation reads it as fulfilled even with a custom status name). Adapter:
`JiraProofAdapter` in `src/integrations/jira.ts`.

**Preferred — hosted Atlassian MCP** (`https://mcp.atlassian.com/v1/mcp`):

| Env var | Required | Where to get it |
| --- | --- | --- |
| `ATLASSIAN_MCP_TOKEN` | yes (MCP path) | An Atlassian API/OAuth token authorized for the Remote MCP server. |
| `ATLASSIAN_MCP_URL` | yes (MCP path) | The MCP server URL (`https://mcp.atlassian.com/v1/mcp`). |
| `JIRA_CLOUD_ID` | if the tool needs it | Your Atlassian site's cloud id. |
| `JIRA_MCP_STATUS_TOOL` | no | Override the issue-read tool name (defaults to `getJiraIssue`); hosted tool names aren't pinned. |

**Fallback — Jira Cloud REST v3** (`GET /rest/api/3/issue/{key}?fields=status`):

| Env var | Required | Where to get it |
| --- | --- | --- |
| `JIRA_BASE_URL` | yes (REST path) | e.g. `https://acme.atlassian.net`. |
| `JIRA_EMAIL` | yes (REST path) | Your Atlassian account email (Basic auth). |
| `JIRA_API_TOKEN` | yes (REST path) | id.atlassian.com → **Security → API tokens → Create**. |

(These are the same vars the Jira **work-item creation** adapter uses.)

---

## Linear — issue status (MCP-preferred, GraphQL fallback)

Reads the linked issue's workflow state, normalizing Linear's **`completed`** state type to
`Done`. Adapter: `LinearProofAdapter` in `src/integrations/linear.ts`.

**Preferred — hosted Linear MCP** (`https://mcp.linear.app/mcp`):

| Env var | Required | Where to get it |
| --- | --- | --- |
| `LINEAR_MCP_TOKEN` | yes (MCP path) | A Linear token/OAuth grant for the hosted MCP server. |
| `LINEAR_MCP_URL` | yes (MCP path) | `https://mcp.linear.app/mcp`. |
| `LINEAR_MCP_STATUS_TOOL` | no | Override the issue-read tool name (defaults to `get_issue`). |

**Fallback — Linear GraphQL** (`issue(id){ state { name type } }`):

| Env var | Required | Where to get it |
| --- | --- | --- |
| `LINEAR_API_KEY` | yes (GraphQL path) | Linear → **Settings → Security & access → Personal API keys**. Sent as the raw `Authorization` header. |

(Same var the Linear work-item creation adapter uses.)

---

## MCP vs REST at a glance

| Source | Real path | Fact returned |
| --- | --- | --- |
| GitHub Actions | REST (always live) | `{ conclusion, status }` → `ci_run` |
| LaunchDarkly | REST | `{ enabled, environment }` → `feature_flag` |
| Statuspage | REST | `{ component_status }` → `status_page` |
| Jira | **MCP** preferred, else REST | `{ status }` → `ticket_status` |
| Linear | **MCP** preferred, else GraphQL | `{ status }` → `ticket_status` |

All facts are single-line, ≤1000 chars, and pass `assertNoRawContent`. Each observation encodes
its check instant in the evidence `ref`, so a genuine state change (e.g. a flag OFF→ON toggle)
lands as a new fact instead of being deduped.
