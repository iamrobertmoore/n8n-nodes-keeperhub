# Starter workflows

Two importable workflows. Both are the shortest honest path from "nothing" to "a transaction on a
block explorer" using n8n plus KeeperHub.

**Import:** n8n → Workflows → ⋯ → *Import from File*. Then open each KeeperHub node once and pick
your credential (the placeholder `REPLACE_WITH_YOUR_CREDENTIAL_ID` is expected; n8n prompts you).

**Before you start:**

1. Install the node: Settings → Community Nodes → `n8n-nodes-keeperhub`.
2. Create a KeeperHub **organization** key (`kh_…`) at [app.keeperhub.com](https://app.keeperhub.com).
   It's behind your avatar menu → Settings → API Keys → **Organisation** tab. Direct URLs like
   `/settings/api-keys` return 404, so navigate through the menu.
3. Fund your KeeperHub org wallet with a little Sepolia ETH. Find the address at
   *Execution → Get* on any past run, or `GET /api/user` → `walletAddress`.
4. Self-hosted only, to use the node as an AI Agent tool:
   `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.

---

## 01 — Safe write with recovery

The one to run first, and the one worth watching.

An "agent" decides to move **999 ETH**, which the wallet cannot afford. The KeeperHub node
simulates before submitting, the dry run catches it, and **no gas is spent**. The failure leaves
the node's error output as structured data rather than crashing the run. A Code node reads the
reason, recalculates something affordable, and the retry lands — returning a real transaction
hash. A final step pulls the audit trail.

What to look at in the output panel:

- `simulation` — the dry run's verdict, before anything was submitted.
- `attempts[]` — every HTTP attempt with status code, outcome, and how long we waited.
- `idempotencyKey` — generated per item, so a replay cannot double-send.
- `gasUsedUnits` / `effectiveGasPriceWei` / `gasCostWei` — honest names. KeeperHub's own
  `gasUsedWei` field carries a gas *unit count*, not wei; see [API-NOTES.md](../API-NOTES.md) §3.
- `transactionLink` — the proof.

This is deliberately not a happy path. One transaction proves you reached the chain once; a
failure that recovers proves the execution layer does its job.

## 02 — AI agent executes onchain

The same node, marked `usableAsTool`, wired to an n8n AI Agent. Ask it in chat to send a small
amount somewhere and it calls KeeperHub directly.

The point: the agent cannot bypass the safety sequence. Simulate-first, idempotency and
retry/backoff live in the node, not in the prompt, so a confused model still cannot double-send or
submit a transaction that will revert.

Bring any chat model — the workflow ships with an OpenAI node purely as a placeholder.
