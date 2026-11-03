# Hotel Offer Orchestrator

A backend service that asks two hotel suppliers for offers in a city, keeps the **cheapest offer for each hotel**, saves the result in **Redis** for fast price filtering, and keeps answering when a supplier is slow or down.

Built with Node.js, TypeScript, Express, **Temporal** and Redis. Runs with one `docker compose up`.

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
10. [Health checks](#10-health-checks)
11. [Running many copies (scaling)](#11-running-many-copies-scaling)
12. [API reference](#12-api-reference)
13. [Project structure](#13-project-structure)
14. [Configuration](#14-configuration)
15. [Tests and CI](#15-tests-and-ci)
16. [Decisions and trade-offs](#16-decisions-and-trade-offs)

---

## 1. Run it

You only need **Docker**.

```bash
docker compose up --build
```

Wait until every service is healthy (`docker compose ps`), then:

| What | Where |
|---|---|
| API | http://localhost:3000 |
| Mock suppliers (+ fault switch) | http://localhost:4000 |
| Temporal UI (see every workflow run) | http://localhost:8233 |

Stop everything with `docker compose down`.

> **Port already in use?** (e.g. Grafana on 3000) Pick other host ports; nothing else changes:
> `API_PORT=3100 MOCKS_PORT=4100 TEMPORAL_UI_PORT=8234 docker compose up --build`
> You can also put these in a `.env` file next to `docker-compose.yml`.

### Without Docker (for development)

Needs Node.js 20+, plus Redis and Temporal running locally:

```bash
docker run -d --name redis -p 6379:6379 redis:7.4-alpine
docker run -d --name temporal -p 7233:7233 -p 8233:8233 \
  temporalio/temporal:1.9.1 server start-dev --ip 0.0.0.0

npm install
npm run dev:worker     # terminal 1
npm run dev:api        # terminal 2
```

Here the mock suppliers are served by the API itself (`SERVE_MOCK_SUPPLIERS=true`, the default), so use `localhost:3000/supplierB/_chaos` instead of port 4000 in the examples below.

---

## 2. Try it

```bash
# All hotels in Delhi (asks both suppliers)
curl -i "localhost:3000/api/hotels?city=delhi"
# → 200, x-cache: MISS

# Hotels between 5000 and 6500 (answered from Redis)
curl -i "localhost:3000/api/hotels?city=delhi&minPrice=5000&maxPrice=6500"
# → 200, x-cache: HIT, 2 hotels

# Health of every part
curl -s localhost:3000/health
```

The mock suppliers can be called directly too:

```bash
curl "localhost:4000/supplierA/hotels?city=delhi"
curl "localhost:4000/supplierB/hotels?city=delhi"
```

Cities with data: `delhi`, `mumbai`, `bangalore`. Any other city returns `[]`.

### Break a supplier on purpose

The fault switch lives on the mock suppliers container (port **4000**). Modes: `ok`, `fail` (500 error), `slow` (waits 5 s, our timeout is 2 s), `bad-data` (broken rows mixed in).

```bash
# 1. One supplier down → still works, with what the other supplier has
curl -X POST localhost:4000/supplierB/_chaos -H 'content-type: application/json' -d '{"mode":"fail"}'
curl -i "localhost:3000/api/hotels?city=mumbai"
# → 200, x-degraded-suppliers: supplierB
curl -s localhost:3000/health
# → "status":"degraded", supplierB down: "supplierB returned 500"

# 2. Both down, city already cached → old data instead of an error
curl -X POST localhost:4000/supplierA/_chaos -H 'content-type: application/json' -d '{"mode":"fail"}'
curl -i "localhost:3000/api/hotels?city=mumbai"
# → 200, x-cache: STALE, x-degraded-suppliers: supplierA,supplierB

# 3. Both down, city never cached → the only error case
curl -i "localhost:3000/api/hotels?city=bangalore"
# → 503 ALL_SUPPLIERS_UNAVAILABLE

# Back to normal
curl -X POST localhost:4000/supplierA/_chaos -H 'content-type: application/json' -d '{"mode":"ok"}'
curl -X POST localhost:4000/supplierB/_chaos -H 'content-type: application/json' -d '{"mode":"ok"}'
```

---

## 3. The big picture

`docker compose up` starts 6 containers on one private network. Containers find each other **by service name** (`redis`, `temporal`, `mock-suppliers`, ...), through Docker's built-in DNS.

```
                 your machine
       :3000          :4000             :8233
         │              │                 │
     ┌───▼───┐          │                 │
     │ nginx │          │                 │
     └───┬───┘          │                 │
         ▼              │                 │
     ┌───────┐  start workflow   ┌────────▼─┐   pull tasks   ┌────────┐
     │  api  │──────────────────▶│ temporal │◀───────────────│ worker │
     └───┬───┘                   └──────────┘                └──┬──┬──┘
         │ read cache                                save cache │  │ call suppliers
         ▼                                                      │  ▼
     ┌───────┐◀─────────────────────────────────────────────────┘ ┌────────────────┐
     │ redis │                                                    │ mock-suppliers │
     └───────┘                                                    └────────────────┘
```

| Container | What it does | Image |
|---|---|---|
| **nginx** | The single way in. Spreads requests across API copies | `nginx` |
| **api** | Takes requests, checks input, decides where data comes from (cache or workflow), answers | ours: `node dist/server.js` |
| **worker** | Runs the workflow: ask A + B in parallel → merge → save | ours: `node dist/worker.js` |
| **temporal** | Runs workflows with timeouts, retries and crash recovery; makes sure one city has one run | `temporalio/temporal` |
| **redis** | Each city's merged hotel list, sorted by price; circuit breaker state | `redis` |
| **mock-suppliers** | Fake Supplier A and B + fault switch. Separate, like a real third party | ours: `node dist/mockSuppliers.js` |

**One image, three programs.** The `Dockerfile` builds our code once; `api`, `worker` and `mock-suppliers` run the same image with a different command.

**Everything talks over the network, by URL.** The worker reaches suppliers through `SUPPLIER_A_URL=http://mock-suppliers:4000/supplierA`. Pointing it at a real supplier is a config change, not a code change.

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

docker-compose runs Redis with `maxmemory 256mb` and `maxmemory-policy allkeys-lru`. It deletes the least-recently-used keys first. This Redis is only a cache, so losing any key is safe: we fetch it again.

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

## 10. Health checks

| Endpoint | For | Checks |
|---|---|---|
| `GET /health` | people, dashboards, monitoring | Redis, Temporal, workers, both suppliers, circuit state |
| `GET /health/live` | Docker / Kubernetes restart checks | nothing: "the process answers" |

`/health/live` stays 200 even when Temporal is down, because restarting the API would not fix Temporal.

```json
{
  "status": "degraded",
  "uptimeSeconds": 17,
  "checks": {
    "redis":    { "status": "up", "latencyMs": 16 },
    "temporal": { "status": "up", "latencyMs": 17 },
    "workers":  { "status": "up", "latencyMs": 19, "pollers": 1 },
    "suppliers": {
      "supplierA": { "status": "up",   "latencyMs": 11, "circuit": "closed" },
      "supplierB": { "status": "down", "latencyMs": 11, "error": "supplierB returned 500", "circuit": "closed" }
    }
  }
}
```

### Status rules

| Status | HTTP | When |
|---|---|---|
| `down` | **503** | no fresh data is possible: Temporal down, **or** no worker polling, **or** no supplier that is up with a closed circuit |
| `degraded` | 200 | still serving, something is missing: one supplier down, a circuit open, or Redis down (no cache, but fresh data works) |
| `ok` | 200 | everything up |

### Built-in protection

| Problem | Protection |
|---|---|
| A probe hangs | each probe stops after 1 s (`HEALTH_PROBE_TIMEOUT_MS`) |
| Monitors call `/health` every second | the report is reused for 5 s (`HEALTH_CACHE_MS`), so suppliers aren't flooded |
| Many calls at the same moment | they share one round of probes |
| Circuit state can't be read (Redis down) | shown as `unknown`, no crash |

**Workers** are found by asking Temporal who recently polled the `hotel-offers` task queue. An idle healthy worker re-polls about every 55 s, so "recent" means the last 90 s.

Code: `src/services/health.service.ts` (rules), `src/services/health.probes.ts` (the real checks).

---

## 11. Running many copies (scaling)

```bash
docker compose up --build --scale api=3 --scale worker=3
```

```
                       ┌─▶ api-1 ─┐
localhost:3000 ─ nginx ┼─▶ api-2 ─┼─▶ temporal ◀── worker-1, worker-2, worker-3
                       └─▶ api-3 ─┘      redis (shared by all)
```

### Why it works

The API keeps nothing important in its own memory, so any copy can answer any request:

| State | Lives in | Shared by all copies? |
|---|---|---|
| Cached hotels | Redis | ✅ |
| Circuit breaker | Redis | ✅ |
| "Is Delhi already being fetched?" | Temporal workflow ID `hotels-delhi` | ✅ |

### How requests are spread

- **API:** each copy runs on port 3000 inside its own container (each has its own IP, so no clash). Only nginx is published on your machine. nginx asks Docker's DNS (`127.0.0.11`) for `api` every 5 s, gets every copy's IP, and rotates requests across them. New or crashed copies are picked up without a restart. The `X-Upstream` response header shows which copy answered.
- **Worker:** no load balancer needed. Workers *pull* tasks from Temporal's `hotel-offers` queue; whichever asks first gets the next task.

### Verified

| Test | Result |
|---|---|
| 6 requests in a row | answered by 3 different API copies |
| 10 requests for `bangalore` at the same moment, spread over 3 APIs | all 200, **1 workflow** in Temporal, suppliers called once each |

Each API copy merges duplicates in its own memory (`inFlight` map); across copies, the workflow ID merges them (see [section 8](#8-many-users-at-once)).

### Notes

- **No Node `cluster` module.** Scaling by containers needs no code change, and is how Kubernetes/ECS scale too.
- **Redis** runs with `maxmemory 256mb` and `allkeys-lru`, and no disk persistence: it is a cache, and losing it costs one supplier round trip per city. Keys use `{city}` hash tags, so moving to Redis Cluster keeps each city's keys on one node.
- **In production**, nginx would be a cloud load balancer (AWS ALB, Kubernetes Service), and the Temporal dev server would be a real Temporal cluster or Temporal Cloud. Only env vars change.

---

## 12. API reference

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

### `GET /health`, `GET /health/live`

See [section 10](#10-health-checks).

### Mock suppliers (port 4000 with Docker)

| Route | Purpose |
|---|---|
| `GET /supplierA/hotels?city=` | Supplier A's hotels |
| `GET /supplierB/hotels?city=` | Supplier B's hotels |
| `POST /supplierA/_chaos` `{"mode": "ok" \| "fail" \| "slow" \| "bad-data"}` | break a supplier |
| `GET /supplierA/_chaos` | current mode |

Same for `supplierB`. An unknown supplier name returns 404 `UNKNOWN_SUPPLIER`.

With Docker these live on their own container (`localhost:4000`), and the API doesn't serve them. Without Docker, the API serves them itself (`SERVE_MOCK_SUPPLIERS=true`); there the fault switch is off when `NODE_ENV=production`.

---

## 13. Project structure

```
src/
  server.ts                  API entry: connects Redis + Temporal, starts HTTP, graceful shutdown
  worker.ts                  Worker entry: runs workflows and activities
  mockSuppliers.ts           Mock suppliers entry (their own container)
  app.ts                     Builds the Express app: routes → controllers → services

  config/        env.ts (settings checked with zod), logger.ts (pino JSON logs)
  routes/        hotels.routes.ts, health.routes.ts            URL → controller
  controllers/   hotels.controller.ts, health.controller.ts    check input, set status + headers
  services/      hotelOffer.service.ts       cache or fresh? fallback? (the decision table)
                 health.service.ts, health.probes.ts   /health rules and checks
  domain/        types.ts, selectBestOffers.ts   pure logic, no I/O
  cache/         redis.ts, hotelCache.ts     Redis connection, save + price-range read
  orchestration/ workflows.ts, activities.ts, client.ts, shared.ts   (Temporal)
  suppliers/     supplierClient.ts, circuitBreaker.ts   calling suppliers safely
  middleware/    requestContext.ts, asyncHandler.ts, errorHandler.ts
  mocks/         supplierData.ts, supplierRouter.ts     fake suppliers + fault switch
  utils/         withTimeout.ts
tests/
  unit/          pure logic and HTTP clients
  integration/   real Redis and a real Temporal test server
Dockerfile                   one image for api, worker and mock-suppliers
docker-compose.yml           redis, temporal, mock-suppliers, worker, api, nginx
deploy/nginx.conf            load balancer in front of the API copies
.github/workflows/ci.yml     typecheck, format, tests, docker build
```

**Rules between folders:** `domain/` imports nothing. `services/` never imports Express. Workflow code never imports config, logger or network code. `mocks/` can be deleted without touching anything else.

**Route order:** the mock router matches `/:supplier/...`, so it is mounted last in `app.ts`; mounted earlier, it would claim paths meant for other routers.

---

## 14. Configuration

All settings come from environment variables. They're checked at startup, and the app refuses to start with a clear message if one is wrong. Defaults are in `.env.example` (for running without Docker); `docker-compose.yml` sets the Docker values (e.g. `REDIS_URL=redis://redis:6379`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | API port |
| `REDIS_URL` | `redis://localhost:6379` | |
| `TEMPORAL_ADDRESS` | `localhost:7233` | |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TEMPORAL_TASK_QUEUE` | `hotel-offers` | |
| `WORKFLOW_TIMEOUT_MS` | `5000` | longest the API waits before using the cache |
| `SUPPLIER_A_URL` / `SUPPLIER_B_URL` | `http://localhost:3000/supplierA` / `B` | |
| `SUPPLIER_TIMEOUT_MS` | `2000` | per supplier call |
| `SERVE_MOCK_SUPPLIERS` | `true` | API also serves the mock suppliers (Docker sets `false`) |
| `CACHE_FRESH_TTL_SECONDS` | `600` | 10 min: younger data is served as fresh |
| `CACHE_HARD_TTL_SECONDS` | `86400` | 24 h: Redis deletes it after this |
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | failures in a row that open the circuit |
| `CIRCUIT_OPEN_SECONDS` | `30` | how long a supplier is skipped |
| `CIRCUIT_RESET_WINDOW_SECONDS` | `60` | failure count resets after this long with no failure |
| `HEALTH_PROBE_TIMEOUT_MS` | `1000` | limit for each `/health` probe |
| `HEALTH_CACHE_MS` | `5000` | `/health` reuses its report for this long |
| `NODE_ENV` | `development` | `production` turns off the fault switch on the API |
| `LOG_LEVEL` | `info` | |

Host ports for `docker compose` (not app settings): `API_PORT` (3000), `MOCKS_PORT` (4000), `TEMPORAL_UI_PORT` (8233).

---

## 15. Tests and CI

```bash
npm test          # all tests (needs Redis on localhost:6379; Temporal tests start their own server)
npm run check     # typecheck + formatting + tests
```

110 tests:

| File | What it proves |
|---|---|
| `unit/selectBestOffers` | cheapest wins, commission tie-break, name matching, stable ties |
| `unit/supplierClient` | timeout, 500, 400, bad rows dropped, not-a-list, unreachable |
| `unit/supplierRouter` | mock data, fault switch modes, switch hidden in production |
| `unit/config` | defaults, bad values listed together, conflicting TTLs rejected, boolean flags |
| `unit/health` | status rules, hanging probe times out, report caching, shared probe round, 200/503 |
| `integration/hotelCache` | atomic save, inclusive range, stale flag, partial eviction → miss, 1,200 hotels |
| `integration/circuitBreaker` | opens at threshold, trial call, resets, allows calls when Redis is down |
| `integration/activities` | circuit open → supplier not called, 4xx not counted |
| `integration/workflow` | degraded mode, retry rules, all-fail, cache-write failure, one run per city |
| `integration/api` | every row of the decision table, validation, request ID, 404, 500 |

**CI** (`.github/workflows/ci.yml`) runs on every push and pull request: typecheck, format check and all tests against a Redis service container, plus `docker compose config` and a Docker image build.

---

## 16. Decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| Full-list request always asks suppliers | the task asks for this, and keeps prices current | every full-list request costs 2 supplier calls (limited by section 8) |
| ZSET + HASH, not one JSON blob | filtering happens **inside** Redis (`ZRANGEBYSCORE`), as the task asks | 3 keys, so we need the partial-eviction check |
| Timeouts aren't retried | a retry doubles the wait for a slow supplier | a supplier that's slow only once loses that one request |
| Stale data beats an error | the task only allows an error when nothing is cached | users may see prices up to 24 h old, clearly marked `STALE` |
| Circuit breaker in Redis, allows calls if Redis is down | shared by all workers; never blocks traffic on its own | when the open period ends, several workers may each send a trial call |
| Mock suppliers in their own container | they stand in for a third party; one copy means one shared fault switch, even when API and worker are scaled | one more container |
| nginx in front of the API | lets `--scale api=N` work behind one address | one more container; real deployments use a cloud load balancer |
| Temporal dev server in compose | one container, no database to set up | in-memory: workflow history is lost on restart. Production uses a Temporal cluster |
| Matching hotels by name | the task says so | real systems would use a shared hotel ID; names can be ambiguous |

### What I'd add next

- **Stale-while-revalidate:** answer a stale price filter immediately and refresh in the background, so no user waits when the 10-minute limit passes.
- **Exactly one trial call** per supplier when a circuit's open period ends (a short `SET NX` lock).
- **Metrics:** supplier latency, error rate, cache hit rate, circuit state (Prometheus).
- **Rate limiting** on `/api/hotels` (e.g. nginx `limit_req`).
- **TLS** at the load balancer.
