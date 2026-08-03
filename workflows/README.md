# Starter workflows

Four importable workflows, from "nothing" to "a transaction on a block explorer" and back again.

**Import:** n8n → Workflows → ⋯ → *Import from File*. Then open each node once and pick your
credential, the placeholder `REPLACE_WITH_YOUR_CREDENTIAL_ID` is expected, and n8n will prompt.

**Before you start:**

1. Install the node: Settings → Community Nodes → `n8n-nodes-keeperhub`.
2. Create a KeeperHub **organization** key (`kh_...`) at [app.keeperhub.com](https://app.keeperhub.com).
   It's behind your avatar menu → Settings → API Keys → **Organisation** tab. Direct URLs like
   `/settings/api-keys` return 404, so navigate through the menu.
3. Fund your KeeperHub org wallet with a little Sepolia ETH. The address is on `GET /api/user` as
   `walletAddress`.
4. Self-hosted only, to use the node as an AI Agent tool:
   `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.

---

## 01, Safe write with recovery

The one to run first.

An "agent" decides to move **999 ETH**, which the wallet cannot afford. The node simulates before
submitting, the dry run catches it, and **no gas is spent**. The failure leaves the node's error
output as structured data rather than crashing the run. A Code node reads the reason, recalculates
something affordable, and the retry lands, returning a real transaction hash. A final step pulls
the audit trail.

What to look at in the output panel:

- `simulation`, the dry run's verdict, before anything was submitted.
- `attempts[]`, every HTTP attempt with status code, outcome, and how long we waited.
- `idempotencyKey`, generated per item, so a replay cannot double-send.
- `gasUsedUnits` / `effectiveGasPriceWei` / `gasCostWei`, honest names. KeeperHub's own
  `gasUsedWei` field carries a gas *unit count*, not wei; see [API-NOTES.md](../API-NOTES.md) §3.
- `transactionLink`, the proof.

Deliberately not a happy path. One transaction proves you reached the chain once; a failure that
recovers proves the execution layer does its job.

## 02, AI agent executes onchain

The node marked `usableAsTool`, wired to an n8n AI Agent running Claude. Ask it in chat to send a
small amount somewhere and it calls KeeperHub directly.

The point: the agent cannot bypass the safety sequence. Simulate-first, idempotency and
retry/backoff live in the node, not in the prompt, so a confused model still cannot double-send or
submit a transaction that will revert. Ask it for an impossible amount and watch it get refused,
then adjust.

Needs an Anthropic credential. Any chat model works, swap the node if you prefer another.

## 03, React to executions

The other direction. **KeeperHub Trigger** polls a KeeperHub workflow's executions and starts an
n8n workflow whenever one reaches a terminal state, filterable to failures only, successes only, or
everything. Failures branch to an alert; successes branch to a receipt log with the real gas cost.

The first poll adopts the current state as a baseline rather than replaying your entire execution
history into the workflow, and terminal execution IDs are remembered so nothing fires twice.

Set the KeeperHub workflow ID on the trigger node before activating.

## 04, Agent via MCP server

Uses n8n's built-in **MCP Client Tool** against KeeperHub's hosted MCP server at
`https://app.keeperhub.com/mcp`, 35 tools, no code required. Complements the node rather than
replacing it: MCP is the broad surface for exploration, the node is the typed, reliability-hardened
path for the writes you actually depend on.

**Setting up the credential**, this is the fiddly bit. The MCP Client Tool cannot use the
KeeperHub credential this package provides; it is a generic node and wants a generic credential:

1. n8n → Credentials → **Create credential** → search **Bearer Auth**.
2. Paste your `kh_` key as the token. Name it something like *KeeperHub MCP (Bearer)*.
3. Open the *KeeperHub MCP Server* node, set **Authentication** to *Bearer Auth*, and pick it.

Also confirm **Server Transport** is set to **HTTP Streamable**, n8n defaults to SSE, and
KeeperHub's endpoint speaks streamable HTTP.
