# TradeArena Explained Simply

TradeArena is a paper trading app. Paper trading means users can practice trading with fake money, not real money.

In this app, a user can:

- create an account
- log in
- get virtual money, like Rs 10,00,000
- search NSE/BSE stocks
- place buy and sell orders
- see cash, equity, profit/loss, positions, fills, and leaderboard
- practice trading without risking real money

The app has multiple parts. Each part has a different job.

## Big Picture

Think of TradeArena like this:

```text
Browser UI
   |
   v
React Frontend
   |
   v
Node.js API Gateway
   |
   +--> PostgreSQL Database
   |
   v
C++ Trading Engine
```

The user only sees the React frontend in the browser.

Behind the scenes:

- React shows the screens and buttons.
- Node.js handles login, users, database, and API routing.
- PostgreSQL saves users, cash, orders, fills, and positions.
- C++ handles the fast trading/order execution logic.

## Frontend

The frontend is inside:

```text
web/
```

It is built with React.

This is what the user sees in the browser:

- login/register screen
- market watch table
- buy/sell order form
- account cards
- positions
- order history
- fills
- leaderboard

The frontend does not directly save data. It talks to the API gateway.

Example:

When you click `Place Paper Buy`, React sends an API request to the gateway.

## API Gateway

The gateway is inside:

```text
gateway/
```

It is built with Node.js.

The gateway is like the main traffic controller.

It does these jobs:

- register users
- login users
- check auth token
- protect API routes
- send orders to the C++ engine
- save order results in PostgreSQL
- return account state to the frontend
- return real leaderboard data
- apply rate limiting
- expose metrics

Important point:

The frontend should normally talk to the gateway at:

```text
http://localhost:8080
```

## C++ Trading Engine

The C++ engine is inside:

```text
engine/
```

It has two main ideas:

1. A matching engine
2. A paper trading engine

The matching engine code is the lower-level exchange-style logic. It is useful for resume-grade engineering because it shows price-time priority order matching.

The running app currently uses the paper trading engine. This engine accepts paper orders and fills them using quote prices.

Example:

If the user places a market buy order for `BPCL`, the C++ engine checks the current quote and fills the order near the ask price.

The C++ backend runs at:

```text
http://localhost:8081
```

## What Is A Matching Engine?

A matching engine is the core system inside an exchange.

Its job is simple:

It matches people who want to buy with people who want to sell.

Example:

```text
Buyer wants to buy RELIANCE at Rs 100
Seller wants to sell RELIANCE at Rs 99
```

The buyer is ready to pay Rs 100.

The seller is ready to sell at Rs 99.

So the matching engine says:

```text
Trade can happen.
```

Then it creates a trade, also called a fill.

The matching engine keeps an order book.

Example:

```text
Buy Orders             Sell Orders
Rs 100 x 10            Rs 101 x 5
Rs 99  x 20            Rs 102 x 8
Rs 98  x 15            Rs 103 x 10
```

The highest buy price is called the best bid.

The lowest sell price is called the best ask.

A trade happens when:

```text
best buy price >= best sell price
```

Example:

```text
Best buy  = Rs 100
Best sell = Rs 99
```

Because Rs 100 is greater than Rs 99, the engine can match them.

The matching engine also follows priority:

1. Better price first
2. If price is same, older order first

This is called price-time priority.

Example:

```text
Order 1: Buy at Rs 100 at 10:00 AM
Order 2: Buy at Rs 100 at 10:01 AM
```

Order 1 gets matched first because it came earlier.

In very easy words:

The matching engine is like a super-fast judge sitting between buyers and sellers. It checks all orders and decides who trades with whom, at what price, and how much quantity.

In this project, the matching engine code is mainly here:

```text
engine/include/matching_engine.hpp
engine/src/matching_engine.cpp
engine/tests/matching_engine_tests.cpp
```

## What Is The Paper Trading Engine?

The paper trading engine is different from the matching engine.

The matching engine tries to behave like a real exchange order book.

The paper trading engine tries to behave like a practice broker account.

Paper trading means:

```text
No real money
No real broker
No real NSE/BSE order
Only virtual trading practice
```

In TradeArena, the paper trading engine does this:

- gives the user virtual cash
- accepts buy and sell orders
- fills market orders using current quote prices
- keeps positions
- calculates cash
- calculates unrealized P&L
- calculates realized P&L
- returns account state to the UI

Example:

User starts with:

```text
Cash = Rs 10,00,000
```

User buys 10 shares of BPCL at Rs 300.

The paper trading engine updates:

```text
Cash decreases by Rs 3,000
BPCL position becomes 10 shares
```

If BPCL price moves to Rs 310, the user has:

```text
Unrealized profit = Rs 100
```

Because:

```text
10 shares x Rs 10 profit = Rs 100
```

If the user sells those 10 shares at Rs 310, then the profit becomes realized.

In very easy words:

The paper trading engine is like a fake broker account for practice. It lets users trade with virtual money and learn without losing real money.

In this project, the paper trading engine code is mainly here:

```text
engine/include/paper_trading.hpp
engine/src/paper_trading.cpp
engine/tests/paper_trading_tests.cpp
```

## Matching Engine vs Paper Trading Engine

Simple difference:

```text
Matching Engine      = exchange logic
Paper Trading Engine = practice trading account logic
```

The matching engine answers:

```text
Which buy order matches which sell order?
```

The paper trading engine answers:

```text
What happens to this user's fake cash, position, and P&L after a trade?
```

Both are useful.

The matching engine is important for serious low-latency exchange engineering.

The paper trading engine is important for making the app usable for normal users.

## PostgreSQL Database

The database stores the important user data.

It saves:

- users
- accounts
- cash balance
- orders
- fills
- positions
- leaderboard-related account data

The database schema is in:

```text
db/schema.sql
```

PostgreSQL runs through Docker.

Because trading state is saved in PostgreSQL, different users now have different accounts.

Example:

If `shreyash` buys RELIANCE, only `shreyash` account changes.

If `demo` logs in, `demo` sees a separate account.

## Redis

Redis is included in Docker Compose for future scaling work.

Redis can be used later for:

- caching
- fast sessions
- market data fanout
- rate limit storage

Right now, PostgreSQL is the main persistent storage.

## Market Data

The app uses free delayed Yahoo Finance-style market data where available.

This is not paid live exchange data.

That means:

- prices can be delayed
- prices may not exactly match Google at every second
- some symbols may fail if free data is unavailable
- this is okay for paper trading and learning

The app also creates bid/ask prices around the last traded price.

Example:

If last price is Rs 100.00:

- bid may be Rs 99.99
- ask may be Rs 100.01

## Orders

The app supports:

- market orders
- limit orders
- buy orders
- sell orders

Market order:

This fills immediately using current bid/ask price.

Limit order:

This waits until the price is good enough.

Example:

If you place a buy limit order at Rs 100, it should only fill when the ask price is Rs 100 or lower.

## Positions

A position means how much stock the user currently owns.

Example:

If you buy 10 shares of BPCL, then your BPCL position is:

```text
BPCL quantity = 10
```

If you sell those 10 shares, the position becomes zero.

## P&L

P&L means profit and loss.

There are two types:

### Unrealized P&L

This is profit or loss on positions still open.

Example:

You bought at Rs 100.

Now price is Rs 105.

You have profit, but you have not sold yet.

That is unrealized profit.

### Realized P&L

This is profit or loss after selling.

Example:

You bought at Rs 100.

You sold at Rs 105.

Now Rs 5 profit is realized.

## Leaderboard

The leaderboard now comes from PostgreSQL.

It ranks real users by equity.

Equity means:

```text
cash + unrealized P&L
```

So if two users have different trades, they should appear separately in the leaderboard.

## How A Trade Works

Here is the simple flow:

```text
1. User clicks Buy in React
2. React sends order to Node gateway
3. Gateway checks login token
4. Gateway sends order to C++ engine
5. C++ engine executes the order
6. Gateway saves order/fill/position/cash in PostgreSQL
7. Gateway returns result to React
8. React updates the screen
```

## How Login Works

Login is handled by the Node gateway.

When a user logs in:

```text
1. User enters email/handle and password
2. Gateway checks PostgreSQL
3. Gateway verifies password
4. Gateway creates a session token
5. React stores that token in browser localStorage
6. Future API calls include that token
```

If the token is missing or wrong, the API returns not authenticated.

## Why We Need The Gateway

The frontend should not talk directly to the database.

The frontend also should not directly control all backend logic.

The gateway gives us one clean place for:

- auth
- security
- database writes
- leaderboard
- rate limiting
- API routing

## Why C++ Is Used

C++ is used for the trading engine because exchange systems need speed and control.

For a resume project, C++ shows serious engineering skills:

- low-level performance
- order matching logic
- deterministic execution
- careful data structures

Node.js and React are used because they are faster to build product features with.

So this project has both:

- serious backend engineering
- usable web app experience

## Docker

Docker Compose is used to run services together.

The main services are:

- C++ backend
- Node gateway
- React frontend
- PostgreSQL
- Redis
- Prometheus

Run all services with:

```sh
docker compose up --build
```

For local development, you can also run services one by one.

## Local Development Commands

Start PostgreSQL:

```sh
docker compose up -d postgres
```

Build C++:

```sh
make server
```

Run C++ backend:

```sh
./build/exchange_server 8081
```

Run Node gateway:

```sh
cd gateway
DATABASE_URL=postgres://tradearena:tradearena@localhost:5432/tradearena BACKEND_URL=http://localhost:8081 npm start
```

Run React frontend:

```sh
cd web
VITE_API_BASE=http://localhost:8080 npm run dev -- --host 127.0.0.1 --port 5173
```

Open:

```text
http://localhost:5173
```

## Tests

Run C++ tests:

```sh
make test
```

Build frontend:

```sh
cd web
npm run build
```

Check gateway syntax:

```sh
cd gateway
node --check server.js
```

## Important Limitations

This is a paper trading app, not a real broker.

It does not place real NSE/BSE orders.

It does not use paid exchange live data.

It should not be used for real money trading.

Free delayed data can be imperfect.

## Good Resume Points

This project shows:

- C++ matching/execution core
- React frontend
- Node.js API gateway
- PostgreSQL persistence
- Docker setup
- Swagger/OpenAPI docs
- rate limiting
- metrics endpoint
- paper trading workflow
- leaderboard
- account isolation per user
- delayed market data integration

## One-Line Summary

TradeArena is a full-stack paper trading platform where React gives the user interface, Node.js manages users and persistence, PostgreSQL stores account data, and C++ performs the trading execution logic.
