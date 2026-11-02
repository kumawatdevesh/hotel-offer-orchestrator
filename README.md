# Hotel Offer Orchestrator

A backend service that asks two hotel suppliers for offers in a city, keeps the **cheapest offer for each hotel**, saves the result in **Redis** for fast price filtering, and keeps answering when a supplier is slow or down.

Built with Node.js, TypeScript, Express, **Temporal** and Redis.

```
GET /api/hotels?city=delhi

Supplier A:  Holtin 6000   Taj 8000
Supplier B:  Holtin 5340   Leela 7000
                 ↓
Answer:      Holtin 5340 (B)   Leela 7000 (B)   Taj 8000 (A)
```

---

## Contents

1. [Run it](#1-run-it)
2. [Try it](#2-try-it)
3. [The big picture](#3-the-big-picture)
4. [How a request flows](#4-how-a-request-flows)
5. [How the best offer is picked](#5-how-the-best-offer-is-picked)
6. [Caching in Redis](#6-caching-in-redis)
7. [When things go wrong](#7-when-things-go-wrong)
8. [Many users at once](#8-many-users-at-once)
9. [Why Temporal](#9-why-temporal)
10. [API reference](#10-api-reference)
11. [Project structure](#11-project-structure)
12. [Configuration](#12-configuration)
13. [Tests](#13-tests)
14. [Decisions and trade-offs](#14-decisions-and-trade-offs)

---

## 1. Run it

You need **Node.js 20+** and **Docker**.

```bash
# 1. Start Redis and a Temporal dev server
docker run -d --name redis -p 6379:6379 redis:7-alpine
docker run -d --name temporal -p 7233:7233 -p 8233:8233 \
  temporalio/temporal:latest server start-dev --ip 0.0.0.0

# 2. Install
npm install

# 3. Start the worker and the API (two terminals)
npm run dev:worker
npm run dev:api
```

The API runs on `http://localhost:3000`. The Temporal UI runs on `http://localhost:8233`.

> **Port 3000 busy?** Use another port, and point the supplier URLs at it too:
> `PORT=3100 SUPPLIER_A_URL=http://localhost:3100/supplierA SUPPLIER_B_URL=http://localhost:3100/supplierB npm run dev:api`
> (set the same supplier URLs for `dev:worker`).

---

## 2. Try it

```bash
# All hotels in Delhi (asks both suppliers)
curl -i "localhost:3000/api/hotels?city=delhi"

# Hotels between 5000 and 6000 (answered from Redis)
curl -i "localhost:3000/api/hotels?city=delhi&minPrice=5000&maxPrice=6000"
```

**Break a supplier on purpose** to see degraded mode. This only works when `NODE_ENV` is not `production`:

```bash
# Make Supplier B slow (it waits 5 s, our timeout is 2 s)
curl -X POST localhost:3000/supplierB/_chaos -H 'content-type: application/json' -d '{"mode":"slow"}'
curl -i "localhost:3000/api/hotels?city=delhi"
# → 200, header  x-degraded-suppliers: supplierB

# Other modes: "fail" (500 error), "bad-data" (broken rows mixed in), "ok" (normal)
curl -X POST localhost:3000/supplierB/_chaos -H 'content-type: application/json' -d '{"mode":"ok"}'
```

Cities with data: `delhi`, `mumbai`, `bangalore`. Any other city returns `[]`.

---

## 3. The big picture

```
                     ┌───────────────────────── API process ─────────────────────────┐
  User ──HTTP──▶     │  route → controller → service ──────────▶  Redis (cache)       │
                     │                          │                                     │
                     │                          ▼                                     │
                     │                 workflow client                                │
                     └──────────────────────────┼─────────────────────────────────────┘
                                                │ "run hotels-delhi"
                                                ▼
                                         Temporal server
                                                │
                     ┌──────────────────────────┼──────── Worker process ─────────────┐
                     │   workflow:  ask A + B in parallel → merge → save              │
                     │                 │                                │             │
                     │                 ▼                                ▼             │
                     │       Supplier A / Supplier B (HTTP)           Redis           │
                     └────────────────────────────────────────────────────────────────┘
```

| Part | What it does |
|---|---|
| **API** | Takes requests, checks input, decides where the data should come from, sends the answer |
| **Redis** | Stores each city's merged hotel list, sorted by price |
| **Temporal** | Runs the "ask suppliers → merge → save" steps, with timeouts, retries and crash recovery |
| **Worker** | The process that runs those steps |
| **Suppliers A and B** | Fake suppliers for this assignment. They live inside the API process, but the worker calls them over HTTP like real ones. |

---

## 4. How a request flows

### A. Full list: `GET /api/hotels?city=delhi`

This always asks the suppliers, so prices are current.

```
1. API checks input             city=delhi ✓
2. API → Temporal               start workflow "hotels-delhi"
3. Worker asks A and B          at the same time, 2 s each
4. Worker merges                cheapest per hotel
5. Worker saves to Redis        all keys in one transaction
6. API answers                  200, x-cache: MISS
```

### B. Price filter: `GET /api/hotels?city=delhi&minPrice=5000&maxPrice=6000`

This is answered from Redis, with no supplier call, as long as the city was saved less than 10 minutes ago.

```
1. API checks input             minPrice ≤ maxPrice ✓
2. API → Redis                  one Lua script: ZRANGEBYSCORE 5000 6000 + HMGET
3. Saved 3 min ago → fresh      200, x-cache: HIT     (about 10 ms)
```

If the city isn't in Redis, or was saved more than 10 minutes ago, the API runs flow **A** first and then filters.

### The whole decision in one place

```
Bad input?                                  → 400
Price filter AND cache fresh (< 10 min)?    → answer from Redis           x-cache: HIT
Otherwise run the workflow:
   worked                                   → fresh answer                x-cache: MISS
                                              (+ x-degraded-suppliers if one supplier failed)
   failed / timed out / Temporal down:
      Redis has any copy (< 24 h)           → old answer                  x-cache: STALE
      Redis has nothing                     → 503
```

This logic lives in `src/services/hotelOffer.service.ts`.

---

## 5. How the best offer is picked

Hotels are matched **by name**, ignoring case and extra spaces, so `"Lemon Tree"` and `"lemon  tree"` are the same hotel.

For each hotel:
1. **Lower price** wins.
2. Same price → **higher commission** wins.
3. Still the same → `supplierA` before `supplierB`, so the answer is the same on every run.

| Hotel | Supplier A | Supplier B | Winner |
|---|---|---|---|
| Holtin | 6000 | 5340 | **B**, cheaper |
| Radison | 5900 · 13% | 5900 · 15% | **B**, same price, more commission |
| Lemon Tree | 3200 | 3350 | **A**, cheaper |
| Taj | 8000 | – | **A**, only one |
| Leela | – | 7000 | **B**, only one |

Bad rows from a supplier (empty name, missing name, negative price, price that isn't a number) are **dropped and logged** before this step, and the good rows still go through.

Code: `src/domain/selectBestOffers.ts`, a pure function with 10 unit tests.

---

## 6. Caching in Redis

### What is stored

Each city has 3 keys:

```
hotels:{delhi}:prices   ZSET   name → price       (sorted, used for price filters)
hotels:{delhi}:offers   HASH   name → full offer  (JSON)
hotels:{delhi}:meta     STRING {"fetchedAt": ..., "count": 5, "degraded": []}
```

- **Writing:** all 3 keys are replaced inside one `MULTI` transaction. A reader sees the full old list or the full new list, never a mix.
- **Reading a price range:** one Lua script runs `ZRANGEBYSCORE`, then `HMGET`, as a single step, so nothing can change the data between the two.
- **`{delhi}` braces:** keep all of a city's keys on the same node if Redis Cluster is used, so the transaction and the script still work.

### How long data stays

| Age | Normal price-filter request | Both suppliers down |
|---|---|---|
| under 10 min (**fresh**) | answered from Redis | answered from Redis |
| 10 min – 24 h (**stale**) | ask suppliers first | old data, `x-cache: STALE` |
| over 24 h | ask suppliers first | `503` |

The 10-minute limit is checked by our code, using `fetchedAt`. The 24-hour limit is a Redis `EXPIRE`, so Redis deletes the keys.

**Why two limits:** with only 10 minutes, the backup would be gone when we need it. With only 24 hours, we'd serve 8-hour-old prices as if they were current.

### When memory is full

Recommended Redis setting: `maxmemory-policy allkeys-lru`. It deletes the least-recently-used keys first. This Redis is only a cache, so losing any key is safe: we fetch it again.

LRU deletes keys **one at a time**, so it can remove a city's `prices` key and keep its `meta`. The Lua script checks that all keys are present (using `count` in meta). If one is missing, it reports "not cached" instead of wrongly returning an empty list.

---

## 7. When things go wrong

| Situation | What the user gets |
|---|---|
| Both suppliers fine | 200, `x-cache: MISS` |
| One supplier fails or is slow | 200 with the other supplier's hotels, `x-degraded-suppliers: supplierB` |
| Both fail, Redis has a copy | 200 with the old data, `x-cache: STALE`, `x-degraded-suppliers: supplierA,supplierB` |
| Both fail, Redis has nothing | **503** `ALL_SUPPLIERS_UNAVAILABLE` |
| Redis is down | still works, just without the cache |
| Temporal is down | same as "both fail" |
| Bad input | 400 with a clear message |

### Timeouts and retries

| Supplier problem | Retry? | Why |
|---|---|---|
| 500 error, connection reset | yes, once after 200 ms | short blips often clear |
| no answer in 2 s (timeout) | **no** | it'll probably be slow again, and a retry doubles the user's wait (measured 4.96 s → 2.17 s after this change) |
| 400 error | no | our request was wrong, so a retry gets the same answer |
| garbage response | no | it'll send the same garbage again |

### Circuit breaker

If a supplier keeps failing, we stop calling it for a while:

```
closed ── 5 failures in a row ──▶ open (skip the supplier for 30 s)
  ▲                                 │ 30 s pass
  └── trial call works ◀── one trial call ── fails ──▶ open again
```

- **Measured:** with B slow, each request took **2.13 s**. Once the circuit opened, requests took **0.05 s**.
- State is stored in **Redis**, so every worker shares it.
- If Redis is down, the breaker **allows** calls. It is never the reason a supplier gets skipped.
- A 400 error doesn't count, because that's our fault, not the supplier's.

Code: `src/suppliers/circuitBreaker.ts`, used in `src/orchestration/activities.ts`.

---

## 8. Many users at once

100 users ask for Delhi at the same moment. Without protection, that's 200 supplier calls for the same answer. Two layers stop it:

| Layer | Where | Effect |
|---|---|---|
| **1. One call per city, per API process** | `inFlight` map in `orchestration/client.ts` | 100 requests → 1 Temporal call |
| **2. One workflow per city, across all servers** | workflow ID `hotels-delhi` + `USE_EXISTING` | 3 API servers → still 1 workflow |

Result: **2 supplier calls** (A once, B once), and all 100 users get the same answer. Both layers are proven by tests in `tests/integration/workflow.test.ts`.

---

## 9. Why Temporal

Temporal is a separate server that runs a list of steps and makes sure they finish.

| What we get | Example |
|---|---|
| Timeout per step | B takes 10 s → stopped after the activity timeout |
| Automatic retries | A returns 500 → tried again after 200 ms |
| Survives crashes | Worker dies after A and B answered → a new worker continues from "save", without calling suppliers again |
| One run per city | the workflow ID makes duplicate requests join the same run |
| You can see every run | open `localhost:8233`, search `hotels-delhi` |

**Workflow code must be deterministic.** Temporal re-runs (replays) it after a crash. So all I/O (HTTP, Redis) is in **activities**, and the workflow only decides the order. That's why `selectBestOffers` is a pure function.

---

## 10. API reference

### `GET /api/hotels`

| Query | Required | Example |
|---|---|---|
| `city` | yes | `delhi` |
| `minPrice` | no | `5000` (inclusive) |
| `maxPrice` | no | `6000` (inclusive) |

**200** returns a JSON array, cheapest first:
```json
[{ "name": "holtin", "city": "delhi", "price": 5340, "commissionPct": 20, "supplier": "supplierB" }]
```

**Response headers**

| Header | Meaning |
|---|---|
| `x-cache` | `MISS` fresh from suppliers · `HIT` from Redis, under 10 min old · `STALE` old copy, suppliers down |
| `x-degraded-suppliers` | suppliers missing from this answer, e.g. `supplierB` |
| `x-data-fetched-at` | when the suppliers were last asked |
| `x-request-id` | find this request in logs and in the Temporal UI (send your own or one is created) |

**Errors** always use one shape: `{ "error": { "code": "...", "message": "..." } }`

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_QUERY` | missing city, price not a number, negative price, `minPrice > maxPrice` |
| 503 | `ALL_SUPPLIERS_UNAVAILABLE` | no supplier answered and nothing is cached |
| 404 | `NOT_FOUND` | unknown route |
| 500 | `INTERNAL` | unexpected error (details only in logs) |

### Mock suppliers

| Route | Purpose |
|---|---|
| `GET /supplierA/hotels?city=` | Supplier A's hotels |
| `GET /supplierB/hotels?city=` | Supplier B's hotels |
| `POST /supplierA/_chaos` `{"mode": "ok" \| "fail" \| "slow" \| "bad-data"}` | break a supplier (not in production) |
| `GET /supplierA/_chaos` | current mode |

---

## 11. Project structure

```
src/
  server.ts                  API entry: connects Redis + Temporal, starts HTTP, graceful shutdown
  worker.ts                  Worker entry: runs workflows and activities
  app.ts                     Builds the Express app: routes → controllers → services

  config/        env.ts (settings checked with zod), logger.ts (pino JSON logs)
  routes/        hotels.routes.ts            URL → controller
  controllers/   hotels.controller.ts        check input, set status + headers
  services/      hotelOffer.service.ts       cache or fresh? fallback? (the decision table)
  domain/        types.ts, selectBestOffers.ts   pure logic, no I/O
  cache/         redis.ts, hotelCache.ts     Redis connection, save + price-range read
  orchestration/ workflows.ts, activities.ts, client.ts, shared.ts   (Temporal)
  suppliers/     supplierClient.ts, circuitBreaker.ts   calling suppliers safely
  middleware/    requestContext.ts, asyncHandler.ts, errorHandler.ts
  mocks/         supplierData.ts, supplierRouter.ts     fake suppliers + fault switch
tests/
  unit/          pure logic and HTTP clients
  integration/   real Redis and a real Temporal test server
```

**Rules between folders:** `domain/` imports nothing. `services/` never imports Express. Workflow code never imports config, logger or network code. `mocks/` can be deleted without touching anything else.

---

## 12. Configuration

All settings come from environment variables. They're checked at startup, and the app refuses to start with a clear message if one is wrong. Defaults are in `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | API port |
| `REDIS_URL` | `redis://localhost:6379` | |
| `TEMPORAL_ADDRESS` | `localhost:7233` | |
| `TEMPORAL_TASK_QUEUE` | `hotel-offers` | |
| `WORKFLOW_TIMEOUT_MS` | `5000` | longest the API waits before using the cache |
| `SUPPLIER_A_URL` / `SUPPLIER_B_URL` | `http://localhost:3000/supplierA` / `B` | |
| `SUPPLIER_TIMEOUT_MS` | `2000` | per supplier call |
| `CACHE_FRESH_TTL_SECONDS` | `600` | 10 min: younger data is served as fresh |
| `CACHE_HARD_TTL_SECONDS` | `86400` | 24 h: Redis deletes it after this |
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | failures in a row that open the circuit |
| `CIRCUIT_OPEN_SECONDS` | `30` | how long a supplier is skipped |
| `CIRCUIT_RESET_WINDOW_SECONDS` | `60` | failure count resets after this long with no failure |
| `NODE_ENV` | `development` | `production` turns off the fault switch |
| `LOG_LEVEL` | `info` | |

---

## 13. Tests

```bash
npm test          # all tests (needs Redis on localhost:6379; Temporal tests start their own server)
npm run check     # typecheck + formatting + tests
```

91 tests:

| File | What it proves |
|---|---|
| `unit/selectBestOffers` | cheapest wins, commission tie-break, name matching, stable ties |
| `unit/supplierClient` | timeout, 500, 400, bad rows dropped, not-a-list, unreachable |
| `unit/supplierRouter` | mock data, fault switch modes, switch hidden in production |
| `unit/config` | defaults, bad values listed together, conflicting TTLs rejected |
| `integration/hotelCache` | atomic save, inclusive range, stale flag, partial eviction → miss, 1,200 hotels |
| `integration/circuitBreaker` | opens at threshold, trial call, resets, allows calls when Redis is down |
| `integration/activities` | circuit open → supplier not called, 4xx not counted |
| `integration/workflow` | degraded mode, retry rules, all-fail, cache-write failure, one run per city |
| `integration/api` | every row of the decision table, validation, request ID, 404, 500 |

---

## 14. Decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| Full-list request always asks suppliers | the task asks for this, and keeps prices current | every full-list request costs 2 supplier calls (limited by section 8) |
| ZSET + HASH, not one JSON blob | filtering happens **inside** Redis (`ZRANGEBYSCORE`), as the task asks | 3 keys, so we need the partial-eviction check |
| Timeouts aren't retried | a retry doubles the wait for a slow supplier | a supplier that's slow only once loses that one request |
| Stale data beats an error | the task only allows an error when nothing is cached | users may see prices up to 24 h old, clearly marked `STALE` |
| Circuit breaker in Redis, allows calls if Redis is down | shared by all workers; never blocks traffic on its own | when the open period ends, several workers may each send a trial call |
| Mock suppliers inside the API process | one less service to run | in production they'd be removed and the URLs pointed at real suppliers |
| Matching hotels by name | the task says so | real systems would use a shared hotel ID; names can be ambiguous |

### What I'd add next

- **Stale-while-revalidate:** answer a stale price filter immediately and refresh in the background, so no user waits when the 10-minute limit passes.
- **Exactly one trial call** per supplier when a circuit's open period ends (a short `SET NX` lock).
- **Metrics:** supplier latency, error rate, cache hit rate, circuit state (Prometheus).
- **Rate limiting** on `/api/hotels`.
