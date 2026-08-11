# n8n-nodes-keeperhub

Execute onchain transactions from [n8n](https://n8n.io) via [KeeperHub](https://keeperhub.com): simulate-first, idempotent, with retries, gas handling and a full audit trail. Marked `usableAsTool`, so any n8n AI Agent can call it directly.

n8n is the reasoning and orchestration layer. KeeperHub is the execution layer. This node is the join.

**[Demo video (3 min)](https://youtu.be/HV9kF7lwW2Q)** · **[npm](https://www.npmjs.com/package/n8n-nodes-keeperhub)** (published from CI with SLSA provenance)

---

## Evidence: transactions landed through this node

Every one of these is a real Ethereum Sepolia transaction produced by the node, not a mockup.

| Transaction | What it proves | Execution |
|---|---|---|
| [`0xdec002f9…8614e6`](https://sepolia.etherscan.io/tx/0xdec002f97d77706d3268324e78539093fdb0c41881e1f44ba0710651ef8614e6) | **The retry that landed after the simulation gate refused the first attempt.** This is the headline run. | via n8n workflow 01 |
| [`0xe0de77f0…432053`](https://sepolia.etherscan.io/tx/0xe0de77f090b9fd58e3029c843b56202a37ebce359cab7bec4572b60a2d432053) | Recipient resolved from the KeeperHub address book **by name**, no hex touched | via node, address-book mode |
| [`0x32d8c429…00a2c3`](https://sepolia.etherscan.io/tx/0x32d8c429d924baac87b356f3e0ead5bd817b391d1c724115cf4d689d3400a2c3) | Full safe-write sequence driven by the node's own code path | `kzfwaljmxmh2ti7h6vi73` |
| [`0x92e86a39…056236`](https://sepolia.etherscan.io/tx/0x92e86a39e14c85c186d7200025f839cb2aa0156e686456ad37115df3f5056236) | **Idempotency**: replaying the same `Idempotency-Key` returned this same execution rather than sending twice | `e35yxn60ex2hu0b4ynk86` |
| [`0x3ebbbbce…80ff00`](https://sepolia.etherscan.io/tx/0x3ebbbbcea0d60a9af356032b9531ff7abee5d7a01083a1eb8d1267432380ff00) | First landed transfer; the `gasUsedWei` finding is evidenced against this one | `x36nqwq71uugpb322iuvk` |
| *(no transaction)* | **Deliberate failure**: `Insufficient ETH balance. Have: 0.0498, Need: 999.0`. Nothing was submitted, so no gas was spent. | `m1csmk3wwvrlhaim3mtln` |

Execution IDs are org-scoped, so the KeeperHub team can look any of them up directly.

**Contributed upstream during the event:** [KeeperHub/keeperhub#1885](https://github.com/KeeperHub/keeperhub/pull/1885), merged. It corrected the execution endpoint paths in the API auth docs, and while reviewing it the maintainer found that `executions/cancel` and `workflows/go-live` were session-only by accident rather than by design. That became ticket KEEP-1083 and a code fix, [#1905](https://github.com/KeeperHub/keeperhub/pull/1905), also merged.

## KeeperHub surfaces used

| Surface | Used | How |
|---|---|---|
| **REST, direct execution** | Yes | `/execute/transfer`, `/execute/contract-call`, polled via `/execute/{id}/status` |
| **REST, workflows** | Yes | list, get, execute, and execution history for the trigger |
| **Audit trail** | Yes | surfaced as structured n8n output, including `errorContext.executionTrace` on failures |
| **Chains API** | Yes | the chain picker is loaded live from `GET /api/chains`, not hardcoded |
| **Workflow builder** | Yes | KeeperHub-authored workflows are what the trigger node polls |
| **MCP server** | Yes | [`workflows/04-mcp-server.json`](./workflows/04-mcp-server.json) points n8n's MCP Client Tool at `https://app.keeperhub.com/mcp`, 35 tools, `kh_` bearer auth |
| **CLI** | No | it is KeeperHub's own tool, not an integration surface |
| **x402 / MPP** | No, deliberately | paying a 402 challenge requires signing a payment, which requires a runtime dependency, and n8n forbids those in a verified community node. Verification is the distribution route for an n8n node, so it was kept |

## Why this exists

KeeperHub already has adapters for LangChain, ElizaOS, OpenClaw and Hermes. It has none for n8n, the largest low-code automation ecosystem there is, with 70+ AI nodes and an AI Agent node that consumes tools. This node opens that audience without anyone writing Solidity.

## What it does

| Resource | Operation | Notes |
|---|---|---|
| **Transfer** | Send | Native or ERC-20, simulate-first, idempotent, polled to a transaction hash |
| **Contract** | Call | Reads return synchronously; writes are submitted and confirmed |
| **Workflow** | List / Get / Execute | Run an existing KeeperHub workflow with JSON input |
| **Execution** | Get / Get Logs | The audit trail, as structured n8n output |
| **KeeperHub Trigger** | Poll | Starts an n8n workflow when a KeeperHub execution finishes |

Chains are loaded live from `GET /api/chains` rather than hardcoded, with testnets sorted first so a first write does not land on mainnet by accident.

**It works in both directions.** The action node lets n8n drive KeeperHub; the trigger node lets a finished KeeperHub execution drive n8n, so failures can page someone and landed transactions can be logged, without hand-rolling a polling loop. The first poll adopts current state as a baseline rather than replaying history, and terminal execution IDs are remembered so nothing fires twice.

## Four starter workflows

Importable JSON in [`workflows/`](./workflows), with setup notes in [`workflows/README.md`](./workflows/README.md):

1. **[Safe write with recovery](./workflows/01-safe-write-with-recovery.json)**, tries to move 999 ETH, gets refused by the simulation gate without spending gas, recalculates, and lands. This is the run in the video.
2. **[AI agent executes onchain](./workflows/02-ai-agent-executes-onchain.json)**, the node as a tool, driven by Claude, picking recipients by name.
3. **[React to executions](./workflows/03-react-to-executions.json)**, the trigger, branching failures to an alert and successes to a receipt log.
4. **[Agent via MCP server](./workflows/04-mcp-server.json)**, n8n's MCP Client Tool against KeeperHub's hosted MCP server.

## Reliability, on purpose

Moving value onchain from an automation tool is not a normal HTTP call. It can fail for reasons that have nothing to do with your request, cost real money when it half-works, and double-spend if you retry it naively. So the reliability handling here is not an afterthought bolted on top, it *is* the transport layer.

**Safe first-write sequence.** Every write follows the documented order: simulate, gate on `success && !wouldRevert`, submit with an `Idempotency-Key`, poll to a terminal state, return `transactionHash`. Each stage appears in the node output, so a reviewer can see the whole chain of custody without leaving n8n.

**Retries that respect the server.** Retries fire on 408/425/429/5xx only. `Retry-After` wins over our own curve; `X-RateLimit-Reset` is the second choice; exponential backoff with full jitter is the fallback, so parallel n8n items do not resonate into a thundering herd. **409 is deliberately not retried**, because an idempotency conflict means the original request is authoritative.

**Polling that respects the server.** `X-Poll-Interval-Hint` takes precedence over the configured interval.

**An `attempts[]` array on every output.** Attempt number, status code, outcome, reason, and how long we waited. A run that hit a 429 and recovered shows exactly that. This is the observability surface, and it is why a retry recovering is visible rather than invisible.

**One error shape.** KeeperHub returns at least three different error envelopes from the same API: structured `{error, detail, request_id, hint}` on some routes, bare `{"error":"Unauthorized"}` on others, and a third shape for unknown routes. `normaliseError()` flattens all three into one type, so an n8n user sees a consistent error regardless of which route they hit.

**Honest gas accounting.** KeeperHub's `gasUsedWei` is byte-identical to its gas *unit* count, so using it as a cost understates spend by about nine orders of magnitude. The node emits `gasUsedUnits`, `effectiveGasPriceWei` and a computed `gasCostWei` under honest names. See [API-NOTES.md](./API-NOTES.md) §3.

**Agents pick recipients by name, not by hex.** Set *Recipient* to **Address Book Entry** and the node resolves a saved KeeperHub address-book label to an address. An LLM only ever has to produce something like `Org Wallet`.

This is not a nicety. Models tokenise text, so they cannot count characters. Asked to sanity-check a valid address, one refused a transfer because it was "one character too long", then in the next sentence gave two different character counts for the same string. No prompt wording fixes that reliably; removing hex from the model's job does. It also means the agent can only send to recipients you have explicitly saved, which is a useful blast radius on its own.

Direct addresses are still supported, and are validated in the node with a clear error naming the actual problem.

## Findings from building this

[API-NOTES.md](./API-NOTES.md) is nine reproducible findings from building against the live API, each with a suggested fix, plus [`scripts/verify-api.mjs`](./scripts/verify-api.mjs), which reproduces every one in a single command with expected-versus-actual output:

```bash
KEEPERHUB_API_KEY=kh_... node scripts/verify-api.mjs
```

One is fixed upstream (#1885 above). Where a later review showed I was wrong, the notes say so and explain why.

## Credential

Organization-scoped key only (`kh_…`), created at `app.keeperhub.com` → API Keys. User-scoped `wfb_` keys authenticate webhook triggers and will not work here.

Key creation is session-only, so it cannot be bootstrapped from n8n. One browser visit is required. This is [KeeperHub issue #1700](https://github.com/KeeperHub/keeperhub/issues/1700).

The credential test probes `GET /api/projects`, **not** `GET /api/workflows`. `/api/workflows` resolves auth with `required: false` and returns `200 []` to anonymous and invalid callers alike, so it cannot distinguish a bad key from an empty account. KeeperHub's own CLI moved its credential probe for the same reason ([KeeperHub/cli#75](https://github.com/KeeperHub/cli/pull/75), KEEP-1049).

## Zero runtime dependencies

n8n's [verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/) forbid runtime dependencies in a community node, so this package cannot ship `@keeperhub/sdk`.

Instead the SDK is a **devDependency**, and [`test/sdk-conformance.ts`](./test/sdk-conformance.ts) asserts at typecheck time that our local mirrors of the REST contract stay assignable to KeeperHub's official types. If KeeperHub changes the contract, CI fails here rather than in someone's production workflow. No runtime weight, no silent drift.

## Install

**n8n Cloud / self-hosted (v1.94.0+):** Settings → Community Nodes → Install → `n8n-nodes-keeperhub`.

**Manual:**

```bash
cd ~/.n8n/nodes
npm install n8n-nodes-keeperhub
```

To use it as an AI Agent tool on a self-hosted instance, set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.

## Development

```bash
npm install
npm run typecheck   # includes the @keeperhub/sdk conformance check
npm run build
npm test
```

## License

MIT
