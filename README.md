# n8n-nodes-keeperhub

Execute onchain transactions from [n8n](https://n8n.io) via [KeeperHub](https://keeperhub.com), simulate-first, idempotent, with retries, gas handling and a full audit trail. Marked `usableAsTool`, so any n8n AI Agent can call it directly.

n8n is the reasoning and orchestration layer. KeeperHub is the execution layer. This node is the join.

---

## Why this exists

KeeperHub already has adapters for LangChain, ElizaOS, OpenClaw and Hermes. It has none for n8n, the largest non-developer automation audience there is, with 70+ AI nodes and an AI Agent node that consumes tools. This node opens that audience without anyone writing Solidity.

## What it does

| Resource | Operation | Notes |
|---|---|---|
| **Transfer** | Send | Native or ERC-20, simulate-first, idempotent, polled to a transaction hash |
| **Contract** | Call | Reads return synchronously; writes are submitted and confirmed |
| **Workflow** | List / Get / Execute | Run an existing KeeperHub workflow with JSON input |
| **Execution** | Get / Get Logs | The audit trail, as structured n8n output |
| **KeeperHub Trigger** | Poll | Starts an n8n workflow when a KeeperHub execution finishes |

Chains are loaded live from `GET /api/chains` rather than hardcoded, with testnets sorted first so a first write does not land on mainnet by accident.

**It works in both directions.** The action node lets n8n drive KeeperHub; the trigger node lets a finished KeeperHub execution drive n8n, so failures can page someone, and landed transactions can be logged, without hand-rolling a polling loop. The first poll adopts current state as a baseline rather than replaying history, and terminal execution IDs are remembered so nothing fires twice.

## Reliability, on purpose

Moving value onchain from an automation tool is not a normal HTTP call. It can fail for reasons that have nothing to do with your request, cost real money when it half-works, and double-spend if you retry it naively. So the reliability handling here is not an afterthought bolted on top, it *is* the transport layer.

**Safe first-write sequence.** Every write follows the documented order: simulate → gate on `success && !wouldRevert` → submit with an `Idempotency-Key` → poll to a terminal state → return `transactionHash`. Each stage appears in the node output, so a reviewer can see the whole chain of custody without leaving n8n.

**Retries that respect the server.** Retries fire on 408/425/429/5xx only. `Retry-After` wins over our own curve; `X-RateLimit-Reset` is the second choice; exponential backoff with full jitter is the fallback, so parallel n8n items do not resonate into a thundering herd. **409 is deliberately not retried**, an idempotency conflict means the original request is authoritative.

**Polling that respects the server.** `X-Poll-Interval-Hint` takes precedence over the configured interval.

**An `attempts[]` array on every output.** Attempt number, status code, outcome, reason, and how long we waited. A run that hit a 429 and recovered shows exactly that. This is the observability surface, and it is why a retry recovering is visible rather than invisible.

**One error shape.** KeeperHub returns at least three different error envelopes from the same API, structured `{error, detail, request_id, hint}` on some routes, bare `{"error":"Unauthorized"}` on others, and a third shape for unknown routes. `normaliseError()` flattens all three into one type, so an n8n user sees a consistent error regardless of which route they hit.

**Agents pick recipients by name, not by hex.** Set *Recipient* to **Address Book Entry** and the node resolves a saved KeeperHub address-book label to an address. An LLM only ever has to produce something like `Org Wallet`.

This is not a nicety. Models tokenise text, so they cannot count characters, asked to sanity-check a valid address, one refused a transfer because it was "one character too long", then in the next sentence gave two different character counts for the same string. No prompt wording fixes that reliably; removing hex from the model's job does. It also means the agent can only send to recipients you have explicitly saved, which is a useful blast radius on its own.

Direct addresses are still supported, and are validated in the node with a clear error naming the actual problem rather than a generic rejection.

## Credential

Organization-scoped key only (`kh_...`), created at `app.keeperhub.com` → API Keys. User-scoped `wfb_` keys authenticate webhook triggers and will not work here.

Key creation is session-only, so it cannot be bootstrapped from n8n, one browser visit is required. This is [KeeperHub issue #1700](https://github.com/KeeperHub/keeperhub/issues/1700).

The credential test probes `GET /api/projects`, **not** `GET /api/workflows`. `/api/workflows` resolves auth with `required: false` and returns `200 []` to anonymous and invalid callers alike, so it cannot distinguish a bad key from an empty account. KeeperHub's own CLI moved its credential probe for the same reason ([KeeperHub/cli#75](https://github.com/KeeperHub/cli/pull/75), KEEP-1049).

## Zero runtime dependencies

n8n's [verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/) forbid runtime dependencies in a community node, so this package cannot ship `@keeperhub/sdk`.

Instead the SDK is a **devDependency**, and `test/sdk-conformance.ts` asserts at typecheck time that our local mirrors of the REST contract stay assignable to KeeperHub's official types. If KeeperHub changes the contract, CI fails here rather than in someone's production workflow. Best of both: no runtime weight, no silent drift.

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
