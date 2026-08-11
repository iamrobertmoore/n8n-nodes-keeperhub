# API notes

Things that surprised me while building this node against the KeeperHub REST API. I'm writing
them down so the next person loses less time, and so the behaviour the node works around is
documented rather than mysterious.

Everything here was reproduced against the live API on 31 July 2026, and you can re-run it:

```bash
KEEPERHUB_API_KEY=kh_... node scripts/verify-api.mjs        # read-only
KEEPERHUB_API_KEY=kh_... node scripts/verify-api.mjs --write # adds simulate-only probes
```

The script prints EXPECTED vs ACTUAL for each check, so you can confirm or refute any of this in
one command instead of taking my word for it. If something here has since been fixed, a PR
deleting the check is very welcome.

---

## 1. `/api/executions` was a docs slug, not a route (merged upstream)

**Status: fixed. [KeeperHub/keeperhub#1885](https://github.com/KeeperHub/keeperhub/pull/1885)
merged 2026-08-03**, and it turned up a real auth bug that KeeperHub then fixed separately in
[#1905](https://github.com/KeeperHub/keeperhub/pull/1905). Kept here with corrections, because two
of my original claims were wrong and the reason is instructive.

`docs/api/authentication.md` listed, under "Accepted on API keys":

> - Workflow CRUD and execution: `/api/workflows`, `/api/executions`, `/api/execute`

`GET /api/executions` returned 404, as did the sub-paths I tried. The real routes are
`GET /api/workflows/{workflowId}/executions`, `GET /api/workflows/executions/{executionId}/status`,
and `GET /api/execute/{executionId}/status`.

**Root cause, from the maintainer:** `/api/executions` was never an API path at all. It is the
*docs page slug*, `docs/api/index.md` links `[Executions](/api/executions)`, and
`docs/api/executions.md` documents endpoints that all live under `/api/workflows/...`. Whoever
wrote the auth page conflated a documentation URL with a route. That is a better explanation than
the one I gave, and worth remembering as a class of bug: a docs site and an API can share a
namespace and drift apart silently.

**Two things I got wrong, corrected on review:**

- **I said there was "no route there at all". There is one.**
  `POST /api/executions/{executionId}/cancel` exists. My probes were GET-only, so I never saw it.
  It resolves auth by session and rejects `kh_` keys, so it belongs in the session-only list rather
  than the accepted one, which is where it now sits.
- **My replacement enumerated `/api/execute` sub-paths and under-covered them.**
  I listed transfer, contract-call, check-and-execute and status, and missed `/swap`, `/node` and
  the `/api/execute/{protocol}/{action}` catch-all, all of which accept `kh_` keys through the same
  gate. The maintainer's point stands: that section is a *scope-boundary list*, not a route index,
  so the loose prefix was strictly more accurate than my precise-but-partial list. Someone
  integrating against `/api/execute/aave/supply` would have read my version and concluded their key
  was rejected, the same class of error the PR was fixing. Being more specific made it worse.

**The useful outcome:** while verifying, the maintainer found that `cancel` and
`/api/workflows/{id}/go-live` were session-only by accident rather than by design, since every
sibling execution route uses `getDualAuthContext` and neither is a credential or human-approval
boundary. That became ticket KEEP-1083 and the fix merged as
[#1905](https://github.com/KeeperHub/keeperhub/pull/1905). So a docs report surfaced a real auth
inconsistency in the code.

## 2. A simulation that completes returns HTTP 400

Three observations on the same endpoint, all on a funded wallet.

**(a) The status code tracks the transaction's predicted outcome, not whether the request was
valid.**

| Call | Outcome | HTTP |
|---|---|---|
| `simulate: true`, transaction is fine | `wouldRevert: false` | **200** |
| `simulate: true`, transaction would fail | `wouldRevert: true` | **400** |
| real execution, transaction actually fails | `status: "failed"` | **202** |

A dry run that correctly predicts a failure is a dry run that worked. The real execution that
genuinely failed returns 202, so the API is stricter about a hypothetical failure than an actual
one.

**(b) `@keeperhub/sdk` therefore throws the result away.** The official SDK raises
`KeeperHubError` on any non-2xx, so callers using it get an exception and never see `wouldRevert`
or `revertReason`, which is the whole point of the flag.

**(c) The dry run's error message was worse than the real one. This has since been fixed.**

Re-checked 11 August 2026, the simulator now returns a clean, typed message that is better than
the execution path's, because it also names the wallet and the shortfall:

```
Insufficient ETH balance. Have: 0.043674521801576, Need: 999.0.
Fund 0xd69865fbd23bcb6548b80c2451e40496c433744e with at least 998.
```

The status code is still `400`, so (a) above stands. Recorded as originally found:

```
simulate: true  ->  "Simulation reverted: missing revert data (action=\"call\", data=null,
                     reason=null, transaction={...})"
real execution  ->  "Insufficient ETH balance. Have: 0.0498, Need: 999.0"
```

The execution path has a clean, typed, actionable message. The simulation path, whose job is to
explain what would go wrong before you spend gas, leaks a raw ethers.js `CALL_EXCEPTION`.

Reproduced on 13 chains: Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia, Polygon Amoy,
Avalanche Fuji, BNB Testnet, Plasma Testnet, Tempo Testnet, 0G Galileo, Ethereum, Base, Tempo.

Suggested fix: return 200 for any simulation that completes, and reuse the execution path's
balance precheck message in the simulator.

How this node handles it: treats a completed simulation as a result regardless of status code, and
surfaces `wouldRevert` and `revertReason` to the user.

## 3. `gasUsedWei` is not wei

A completed execution returns:

```json
"gasUsedWei": "76879",
"result": { "gasUsedUnits": "76879", "effectiveGasPrice": "1001070165" }
```

`gasUsedWei` is byte-identical to `gasUsedUnits`. It's a gas unit count, not a wei amount. The
actual cost was `76879 x 1001070165 = 76,961,273,215,035 wei`, so the field understates spend by
about nine orders of magnitude.

Cost tracking, spending caps or billing built on the documented field name will be wrong, and it
fails silently because both values are plausible-looking integers.

Evidence: execution `x36nqwq71uugpb322iuvk`,
[tx `0x3ebbbb...80ff00`](https://sepolia.etherscan.io/tx/0x3ebbbbcea0d60a9af356032b9531ff7abee5d7a01083a1eb8d1267432380ff00).

Suggested fix: rename it to `gasUsedUnits` and add a real `gasCostWei`.

How this node handles it: emits `gasUsedUnits`, `effectiveGasPriceWei` and a computed `gasCostWei`
under honest names, so nobody builds a spending cap on the mislabelled field.

## 4. `GET /api/chains` has no `status` field

The quickstart calls `/api/chains` "the live source of truth" and says "Each chain includes a
`status` field (stable, experimental, deprecated)".

Live response: 0 of 22 chains carry a `status` key. It's absent, not null. The actual keys are
`id, chainId, name, symbol, chainType, explorerUrl, explorerAddressPath, explorerApiUrl,
explorerApiType, isTestnet, isEnabled, usePrivateMempoolRpc`. The docs also list 9 chains while the
API returns 22, including Solana, BNB, Avalanche, Plasma, Tempo and 0G.

Suggested fix: project `status` into the `/api/chains` serializer, or drop the sentence.

## 5. No rate-limit headers are emitted

Documented limits are 100/min authenticated, 10/min unauthenticated, 60/min direct execution. No
response I saw carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` or
`Retry-After`, on `/chains`, `/projects`, or anything else I tried. 130 sequential authenticated
requests all returned 200 and I never saw a 429.

So a client can't discover its remaining budget or the right backoff, and has to guess.

Suggested fix: emit `X-RateLimit-*` on every response and `Retry-After` on 429.

How this node handles it: honours `Retry-After` and `X-RateLimit-Reset` when present, and falls
back to exponential backoff with full jitter when they aren't.

## 6. `GET /api/workflows` accepts anonymous callers

Anonymous, invalid-key and valid-key requests all return 200. This is intended, since the route
resolves auth with `required: false`. But it's also the exact call the authentication docs use as
their "check your key works" example, so the documented smoke test succeeds with a wrong key.

KeeperHub's own CLI moved its credential probe off this endpoint for the same reason
([KeeperHub/cli#75](https://github.com/KeeperHub/cli/pull/75), KEEP-1049).

How this node handles it: the credential test probes `GET /api/projects`, which returns a real 401.

Suggested fix (docs only): use a 401-ing endpoint in the authentication example.

## 7. Three different error envelopes

| Route | Shape |
|---|---|
| `/integrations` | `{error, detail, hint, request_id}` |
| `/projects`, `/keys`, `/tags`, `/organizations` | `{error}` |
| unknown routes | `{error, detail, request_id}` |

How this node handles it: `normaliseError()` in
[`nodes/KeeperHub/transport.ts`](./nodes/KeeperHub/transport.ts) flattens all three into one type.
Happy to contribute that upstream if it's useful.

## 8. The SDK omits the reliability primitives

`@keeperhub/sdk@0.1.1` has no `simulate`, no `Idempotency-Key`, no `Retry-After` handling, no
`X-Poll-Interval-Hint` and no `/chains`. `pollUntilDone()` uses a fixed interval and ignores server
hints. You can't follow the documented safe first-write sequence with the official SDK without
dropping to `rawRequest`.

There's a working implementation of all of it in
[`nodes/KeeperHub/transport.ts`](./nodes/KeeperHub/transport.ts). I'd be glad to open a PR against
`KeeperHub/sdk` if that's wanted.

## 9. Smaller things

- **Gas sponsorship is wider than documented.** KeeperHub's site says sponsorship covers mainnet
  Ethereum. A completed Sepolia execution returned `"sponsored": true`.
- **No REST route for wallet balance.** `/api/wallet`, `/api/wallets`, `/api/wallet/balance` and
  `/api/wallets/balance` all 404. Balance is only reachable via `kh wallet balance` or the
  dashboard, so "check your balance before your first write" can't be automated over REST, which
  is the path a headless integration takes.
- **No settings UI at a guessable URL.** `/settings`, `/settings/api-keys`, `/api-keys`,
  `/org/settings`, `/account`, `/organization/settings`, `/settings/keys`, `/developer` and `/keys`
  all 404, while the docs say "Navigate to Settings, then API Keys". It's reachable through the
  avatar menu.
- **Signing in with GitHub skips the Turnstile challenge and the forced TOTP enrolment** that the
  email path imposes, and provisions the org and org wallet silently. Worth saying in the
  quickstart, since it's the shorter route.
- **Replayed idempotency keys aren't marked.** The same `Idempotency-Key` correctly returns the
  same `executionId`, but with no replay header or body flag, so a caller can't tell a replay from
  a fresh execution. There's already an open upstream PR for this.
- **`X-Poll-Interval-Hint` is emitted.** I saw it as `0` on a completed execution. This node treats
  a non-positive hint as "no guidance" and uses its configured interval.
- **0G Galileo (`16602`) is `isEnabled: true` but its RPC is down.** Simulations come back with
  "RPC failed on both endpoints".

## Checked and withdrawn

I thought the workflow execute route was singular-only (`POST /api/workflow/{id}/execute`) while
every other workflow route is plural. Both spellings return 405 on GET, so both routes exist. I'm
noting it because it's the kind of thing that's easy to assert and wrong.

---

## Executions produced while writing this

| Execution | Status | Transaction |
|---|---|---|
| `x36nqwq71uugpb322iuvk` | completed | [`0x3ebbbb...80ff00`](https://sepolia.etherscan.io/tx/0x3ebbbbcea0d60a9af356032b9531ff7abee5d7a01083a1eb8d1267432380ff00) |
| `e35yxn60ex2hu0b4ynk86` | completed (an idempotency replay returned this same id) | [`0x92e86a...056236`](https://sepolia.etherscan.io/tx/0x92e86a39e14c85c186d7200025f839cb2aa0156e686456ad37115df3f5056236) |
| `kzfwaljmxmh2ti7h6vi73` | completed, through the node itself | [`0x32d8c4...00a2c3`](https://sepolia.etherscan.io/tx/0x32d8c429d924baac87b356f3e0ead5bd817b391d1c724115cf4d689d3400a2c3) |
| `m1csmk3wwvrlhaim3mtln` | failed on purpose: `Insufficient ETH balance. Have: 0.0498, Need: 999.0` | none |
