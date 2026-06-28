# TradeArena

TradeArena is a real-time paper trading platform powered by a C++ execution
core and a React frontend.

Users can create a local profile, start with Rs 10,00,000 virtual cash, search
stocks, place buy/sell paper orders, track portfolio P&L, replay fills, and see
a local leaderboard.

The original from-scratch price-time priority matching engine is still present
under `engine/include/matching_engine.hpp` and covered by tests, but the running
app currently uses a paper fill simulator around delayed NSE/BSE-style quotes.

The app now has PostgreSQL-backed register/login through the Node.js gateway.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the full gateway, PostgreSQL, Redis,
WebSocket, Docker, and AWS roadmap.

## Simple Login Flow

1. Start Postgres:

```sh
docker compose up -d postgres
```

2. Start the C++ backend:

```sh
make server
./build/exchange_server 8081
```

3. Start the Node gateway:

```sh
cd gateway
npm install
DATABASE_URL=postgres://tradearena:tradearena@localhost:5432/tradearena \
BACKEND_URL=http://localhost:8081 \
npm start
```

4. Start the frontend:

```sh
cd web
npm install
VITE_API_BASE=http://localhost:8080 npm run dev -- --host 127.0.0.1 --port 5173
```

5. Open `http://127.0.0.1:5173`, create an account, then trade.

## Backend

Build and test:

```sh
make test
make server
```

Run the HTTP/SSE TradeArena API:

```sh
./build/exchange_server 8081
```

Run the Node.js API Gateway:

```sh
cd gateway
BACKEND_URL=http://localhost:8081 npm start
```

Gateway endpoints:

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /me`
- `GET /health`
- `GET /metrics`
- `GET /ws/market-data` as a WebSocket upgrade endpoint
- all backend API routes proxied under the same paths

API:

- `GET /docs` for Swagger UI
- `GET /openapi.json` for the OpenAPI document
- `GET /api/state`
- `GET /api/search?q=SBICARD`
- `POST /api/symbols`
- `POST /api/orders`
- `DELETE /api/orders/{id}`
- `POST /api/reset`
- `GET /api/events` for Server-Sent Events

Order JSON:

```json
{
  "id": 1,
  "symbol": "RELIANCE",
  "side": "buy",
  "type": "market",
  "price": 0,
  "quantity": 10
}
```

Prices are integer paise/ticks and quantities are integer lots. The app uses
free delayed Yahoo Finance NSE/BSE data where available and simulated bid/ask
around the delayed last price.

## Frontend

Install dependencies and run Vite:

```sh
cd web
npm install
npm run dev
```

The frontend can talk directly to the C++ backend or to the gateway. For the
gateway:

```sh
VITE_API_BASE=http://localhost:8080 npm run dev -- --host 127.0.0.1 --port 5173
```

## Docker

```sh
docker compose up --build
```

Compose starts:

- C++ backend on `8081`
- Node API Gateway on `8080`
- Frontend on `5173`
- PostgreSQL on `5432`
- Redis on `6379`
- Prometheus on `9090`

## Load Test

```sh
BASE_URL=http://localhost:8080 REQUESTS=1000 CONCURRENCY=50 node scripts/load_test.js
```

## Production Notes

AWS ECS/Fargate scaffolding lives in [deploy/aws](deploy/aws). Actual AWS
deployment still requires your AWS account ID, region, ECR repositories, VPC,
subnets, domain, TLS certificate, and IAM roles.


 codex resume 019efd7d-29dc-7eb1-af94-c94506e696af
bA5v7KtIhyIFrH8i

postgresql://postgres:bA5v7KtIhyIFrH8i@db.qbwskelvnmqpanxnzswt.supabase.co:5432/postgres