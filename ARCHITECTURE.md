# TradeArena Architecture

TradeArena is a real-time paper trading platform. The current repository is an
MVP that runs locally with a C++ paper trading backend and React frontend. The
architecture below is the target path for turning it into a resume-grade system.

## Current Implementation

- React/Vite frontend
- C++ HTTP/SSE backend
- Node.js API Gateway
- Virtual account with starting balance of Rs 10,00,000
- Stock search through Yahoo Finance delayed NSE/BSE data
- Market and limit paper orders
- Portfolio, P&L, order history, trade replay, and local leaderboard
- Swagger docs at `/docs`
- WebSocket market data fanout at `/ws/market-data`
- Rate limiting and Prometheus metrics in the gateway
- PostgreSQL schema for durable users, orders, fills, competitions, and badges
- Redis and PostgreSQL services in Docker Compose

## Target System

```text
React / Next.js Frontend
        |
        | HTTPS / WebSocket
        v
Node.js API Gateway
        |
        | auth, rate limits, REST, WebSocket fanout
        v
C++ Matching / Execution Engine
        |
        +--> PostgreSQL: users, accounts, orders, fills, competitions
        +--> Redis: sessions, leaderboards, cached quotes, rate limits
        +--> Market Data Service: broker/vendor/free delayed feed adapters
```

## Phase 1: MVP

- User login/profile
- Virtual balance
- Buy/sell stocks
- Portfolio page
- Order history
- Simple market data simulator or delayed public data

Status: implemented locally. Login/profile is local-browser based in the UI;
database-backed auth schema exists for the next persistence pass.

## Phase 2: Serious Engineering

- C++ matching engine as the execution core
- Market and limit orders
- Order book depth
- Trade execution logs
- WebSocket/SSE price updates
- Durable order and fill persistence

Status: matching engine exists in `engine/include/matching_engine.hpp`; market
and limit orders are available in the running paper app; execution logs exist as
fills; SSE and gateway WebSocket updates are available.

## Phase 3: Community

- Leaderboard
- Public profiles
- Weekly trading competitions
- Badges
- Invite friends

Status: local leaderboard and profile UI are implemented. PostgreSQL tables are
present for competitions and badges; Redis is included for sorted-set
leaderboards in a production implementation.

## Phase 4: Resume-Grade Scaling

- Redis caching and rate limiting
- Docker deployment
- AWS ECS or EC2
- Structured logging
- Metrics and monitoring
- Load testing

Status: Docker Compose runs backend, gateway, frontend, PostgreSQL, Redis, and
Prometheus. The gateway exposes metrics and rate limiting. AWS ECS scaffolding
is included under `deploy/aws/`.
