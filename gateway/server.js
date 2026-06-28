const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 8080);
const BACKEND_URL = 'https://tradearena-backend.onrender.com';
const DATABASE_URL = 'postgresql://postgres:bA5v7KtIhyIFrH8i@db.qbwskelvnmqpanxnzswt.supabase.co:6543/postgres';
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 240);

const clients = new Set();
const buckets = new Map();
const sessions = new Map();
const pool = new Pool({
  connectionString: DATABASE_URL,
  family: 4,
  ssl: { rejectUnauthorized: false },
});
const metrics = {
  startedAt: Date.now(),
  requests: 0,
  proxied: 0,
  rateLimited: 0,
  wsConnections: 0,
  wsMessages: 0,
  errors: 0,
};

async function ensureAuthSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    DO $$ BEGIN
      CREATE TYPE order_side AS ENUM ('buy', 'sell');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
    DO $$ BEGIN
      CREATE TYPE order_type AS ENUM ('market', 'limit');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
    DO $$ BEGIN
      CREATE TYPE order_status AS ENUM ('open', 'filled', 'cancelled', 'rejected');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email TEXT UNIQUE NOT NULL,
      handle TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cash_paise BIGINT NOT NULL DEFAULT 100000000,
      realized_pnl_paise BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id BIGINT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      side order_side NOT NULL,
      type order_type NOT NULL,
      price_paise BIGINT NOT NULL DEFAULT 0,
      quantity BIGINT NOT NULL CHECK (quantity > 0),
      remaining BIGINT NOT NULL CHECK (remaining >= 0),
      status order_status NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS fills (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      order_id BIGINT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      side order_side NOT NULL,
      price_paise BIGINT NOT NULL,
      quantity BIGINT NOT NULL CHECK (quantity > 0),
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS positions (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      quantity BIGINT NOT NULL,
      average_price_paise BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_id_id ON orders(user_id, id);
    CREATE INDEX IF NOT EXISTS idx_fills_user_executed ON fills(user_id, executed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
  `);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-tradearena-user,authorization',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function backendJson(method, path, currentUser, body = null) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, BACKEND_URL);
    const headers = {
      host: target.host,
      'x-tradearena-user': currentUser.row.handle,
    };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.length);
    }
    const requestModule = target.protocol === 'https:' ? https : http;
    const upstream = requestModule.request(target, { method, headers }, (upstreamRes) => {
      let text = '';
      upstreamRes.setEncoding('utf8');
      upstreamRes.on('data', (chunk) => {
        text += chunk;
      });
      upstreamRes.on('end', () => {
        try {
          resolve({
            status: upstreamRes.statusCode || 502,
            data: text ? JSON.parse(text) : null,
            text,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    upstream.on('error', reject);
    if (body) {
      upstream.end(body);
    } else {
      upstream.end();
    }
  });
}

function quoteMap(quotes) {
  const map = new Map();
  for (const quote of quotes || []) {
    map.set(quote.symbol, quote);
  }
  return map;
}

async function persistedState(currentUser, backendState) {
  const userId = currentUser.row.id;
  const [accountResult, positionResult, openOrderResult, fillResult] = await Promise.all([
    pool.query('SELECT cash_paise, realized_pnl_paise FROM accounts WHERE user_id = $1', [userId]),
    pool.query(
      `SELECT symbol, quantity, average_price_paise
       FROM positions
       WHERE user_id = $1 AND quantity <> 0
       ORDER BY symbol`,
      [userId],
    ),
    pool.query(
      `SELECT id, symbol, side, type, price_paise, quantity, remaining, status
       FROM orders
       WHERE user_id = $1 AND status = 'open'
       ORDER BY created_at DESC`,
      [userId],
    ),
    pool.query(
      `SELECT order_id, symbol, side, price_paise, quantity
       FROM fills
       WHERE user_id = $1
       ORDER BY executed_at DESC
       LIMIT 50`,
      [userId],
    ),
  ]);

  const accountRow = accountResult.rows[0] || currentUser.row;
  const quotesBySymbol = quoteMap(backendState.quotes);
  let unrealizedPnl = 0;
  const positions = positionResult.rows.map((row) => {
    const quote = quotesBySymbol.get(row.symbol);
    const markPrice = quote ? Math.round((Number(quote.bid) + Number(quote.ask)) / 2) : Number(row.average_price_paise);
    const quantity = Number(row.quantity);
    const averagePrice = Number(row.average_price_paise);
    const positionPnl = (markPrice - averagePrice) * quantity;
    unrealizedPnl += positionPnl;
    return {
      symbol: row.symbol,
      quantity,
      averagePrice,
      markPrice,
      unrealizedPnl: positionPnl,
    };
  });

  const cash = Number(accountRow.cash_paise);
  const realizedPnl = Number(accountRow.realized_pnl_paise);
  return {
    ...backendState,
    account: {
      cash,
      equity: cash + unrealizedPnl,
      realizedPnl,
      unrealizedPnl,
    },
    positions,
    openOrders: openOrderResult.rows.map((row) => ({
      id: Number(row.id),
      symbol: row.symbol,
      side: row.side,
      type: row.type,
      price: Number(row.price_paise),
      quantity: Number(row.quantity),
      remaining: Number(row.remaining),
      status: row.status,
    })),
    fills: fillResult.rows.map((row) => ({
      orderId: Number(row.order_id),
      symbol: row.symbol,
      side: row.side,
      price: Number(row.price_paise),
      quantity: Number(row.quantity),
    })),
  };
}

async function leaderboardRows(backendState) {
  const [accountResult, positionResult] = await Promise.all([
    pool.query(
      `SELECT u.id, u.handle, u.display_name, a.cash_paise, a.realized_pnl_paise
       FROM users u
       JOIN accounts a ON a.user_id = u.id`,
    ),
    pool.query(
      `SELECT user_id, symbol, quantity, average_price_paise
       FROM positions
       WHERE quantity <> 0`,
    ),
  ]);
  const quotesBySymbol = quoteMap(backendState.quotes);
  const byUser = new Map();
  for (const row of accountResult.rows) {
    byUser.set(row.id, {
      name: row.display_name,
      handle: row.handle,
      cash: Number(row.cash_paise),
      realizedPnl: Number(row.realized_pnl_paise),
      unrealizedPnl: 0,
      equity: Number(row.cash_paise),
    });
  }
  for (const row of positionResult.rows) {
    const user = byUser.get(row.user_id);
    if (!user) continue;
    const quote = quotesBySymbol.get(row.symbol);
    const markPrice = quote ? Math.round((Number(quote.bid) + Number(quote.ask)) / 2) : Number(row.average_price_paise);
    const pnl = (markPrice - Number(row.average_price_paise)) * Number(row.quantity);
    user.unrealizedPnl += pnl;
    user.equity += pnl;
  }
  return Array.from(byUser.values())
    .sort((left, right) => right.equity - left.equity)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

async function applyPersistentFill(client, userId, fill) {
  const symbol = String(fill.symbol);
  const side = String(fill.side);
  const price = Number(fill.price);
  const quantity = Number(fill.quantity);
  const signedQuantity = side === 'buy' ? quantity : -quantity;
  const positionResult = await client.query(
    `SELECT quantity, average_price_paise
     FROM positions
     WHERE user_id = $1 AND symbol = $2
     FOR UPDATE`,
    [userId, symbol],
  );
  const current = positionResult.rows[0] || { quantity: 0, average_price_paise: 0 };
  const oldQuantity = Number(current.quantity);
  const oldAverage = Number(current.average_price_paise);
  let newQuantity = oldQuantity + signedQuantity;
  let newAverage = oldAverage;
  let realizedDelta = 0;

  if (oldQuantity === 0 || (oldQuantity > 0 && signedQuantity > 0) || (oldQuantity < 0 && signedQuantity < 0)) {
    const oldNotional = oldAverage * oldQuantity;
    const newNotional = price * signedQuantity;
    newAverage = newQuantity === 0 ? 0 : Math.trunc((oldNotional + newNotional) / newQuantity);
  } else {
    const closingQuantity = Math.min(Math.abs(oldQuantity), Math.abs(signedQuantity));
    const direction = oldQuantity > 0 ? 1 : -1;
    realizedDelta = (price - oldAverage) * closingQuantity * direction;
    if (newQuantity === 0) {
      newAverage = 0;
    } else if ((newQuantity > 0 && signedQuantity > 0) || (newQuantity < 0 && signedQuantity < 0)) {
      newAverage = price;
    }
  }

  await client.query(
    `INSERT INTO fills (order_id, user_id, symbol, side, price_paise, quantity)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [Number(fill.orderId), userId, symbol, side, price, quantity],
  );
  if (newQuantity === 0) {
    await client.query('DELETE FROM positions WHERE user_id = $1 AND symbol = $2', [userId, symbol]);
  } else {
    await client.query(
      `INSERT INTO positions (user_id, symbol, quantity, average_price_paise, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, symbol)
       DO UPDATE SET quantity = EXCLUDED.quantity,
                     average_price_paise = EXCLUDED.average_price_paise,
                     updated_at = now()`,
      [userId, symbol, newQuantity, newAverage],
    );
  }
  await client.query(
    `UPDATE accounts
     SET cash_paise = cash_paise - $2,
         realized_pnl_paise = realized_pnl_paise + $3,
         updated_at = now()
     WHERE user_id = $1`,
    [userId, signedQuantity * price, realizedDelta],
  );
}

async function persistOrderAck(currentUser, ack) {
  if (!ack || !ack.order || !ack.order.id) return;
  const userId = currentUser.row.id;
  const order = ack.order;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO orders (id, user_id, symbol, side, type, price_paise, quantity, remaining, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (user_id, id)
       DO UPDATE SET symbol = EXCLUDED.symbol,
                     side = EXCLUDED.side,
                     type = EXCLUDED.type,
                     price_paise = EXCLUDED.price_paise,
                     quantity = EXCLUDED.quantity,
                     remaining = EXCLUDED.remaining,
                     status = EXCLUDED.status,
                     updated_at = now()`,
      [
        Number(order.id),
        userId,
        String(order.symbol),
        String(order.side),
        String(order.type),
        Number(order.price || 0),
        Number(order.quantity || 0),
        Number(order.remaining || 0),
        String(order.status || (ack.accepted ? 'open' : 'rejected')),
      ],
    );
    for (const fill of ack.fills || []) {
      await applyPersistentFill(client, userId, fill);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function resetPersistentAccount(currentUser) {
  const userId = currentUser.row.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM fills WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM orders WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM positions WHERE user_id = $1', [userId]);
    await client.query(
      `UPDATE accounts
       SET cash_paise = 100000000,
           realized_pnl_paise = 0,
           updated_at = now()
       WHERE user_id = $1`,
      [userId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    name: row.display_name,
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120_000, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [algorithm, salt, hash] = String(stored).split('$');
  if (algorithm !== 'pbkdf2_sha256' || !salt || !hash) return false;
  const candidate = hashPassword(password, salt).split('$')[2];
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}

function createToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now() });
  return token;
}

async function userFromToken(token) {
  const session = sessions.get(token);
  if (!session) return null;
  const result = await pool.query(
    `SELECT u.id, u.email, u.handle, u.display_name, a.cash_paise, a.realized_pnl_paise
     FROM users u
     JOIN accounts a ON a.user_id = u.id
     WHERE u.id = $1`,
    [session.userId],
  );
  if (!result.rows[0]) {
    sessions.delete(token);
    return null;
  }
  return { token, row: result.rows[0] };
}

async function userFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return userFromToken(token);
}

async function handleAuth(req, res) {
  if (req.method === 'POST' && req.url === '/auth/register') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const handle = String(body.handle || '').trim().toLowerCase().replace(/\s+/g, '');
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (!email.includes('@') || handle.length < 3 || name.length < 2 || password.length < 6) {
      json(res, 400, { error: 'enter valid email, name, handle, and 6+ character password' });
      return;
    }
    try {
      const passwordHash = hashPassword(password);
      const result = await pool.query(
        `INSERT INTO users (email, handle, display_name, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, handle, display_name`,
        [email, handle, name, passwordHash],
      );
      await pool.query('INSERT INTO accounts (user_id) VALUES ($1)', [result.rows[0].id]);
      const token = createToken(result.rows[0].id);
      json(res, 201, {
        token,
        user: publicUser(result.rows[0]),
        account: { cash: 100000000, realizedPnl: 0 },
      });
    } catch (error) {
      const duplicate = error.code === '23505';
      json(res, duplicate ? 409 : 500, { error: duplicate ? 'email or handle already exists' : 'registration failed' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/auth/login') {
    const body = await readBody(req);
    const login = String(body.login || '').trim().toLowerCase();
    const password = String(body.password || '');
    const result = await pool.query(
      `SELECT u.id, u.email, u.handle, u.display_name, u.password_hash, a.cash_paise, a.realized_pnl_paise
       FROM users u
       JOIN accounts a ON a.user_id = u.id
       WHERE u.email = $1 OR u.handle = $1`,
      [login],
    );
    const row = result.rows[0];
    if (!row || !verifyPassword(password, row.password_hash)) {
      json(res, 401, { error: 'invalid login or password' });
      return;
    }
    const token = createToken(row.id);
    json(res, 200, {
      token,
      user: publicUser(row),
      account: { cash: Number(row.cash_paise), realizedPnl: Number(row.realized_pnl_paise) },
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/auth/logout') {
    const current = await userFromRequest(req);
    if (current) sessions.delete(current.token);
    json(res, 200, { logout: true });
    return;
  }

  if (req.method === 'GET' && req.url === '/me') {
    const current = await userFromRequest(req);
    if (!current) {
      json(res, 401, { error: 'not authenticated' });
      return;
    }
    json(res, 200, {
      user: publicUser(current.row),
      account: {
        cash: Number(current.row.cash_paise),
        realizedPnl: Number(current.row.realized_pnl_paise),
      },
    });
    return;
  }

  json(res, 404, { error: 'not found' });
}

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function rateLimited(req) {
  const key = `${clientIp(req)}:${req.headers['x-tradearena-user'] || 'anonymous'}`;
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || now >= current.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT_MAX;
}

function proxy(req, res, currentUser = null, pathOverride = null) {
  const target = new URL(pathOverride || req.url, BACKEND_URL);
  const send = (body = null) => {
    const headers = {
      ...req.headers,
      host: target.host,
    };
    if (currentUser) {
      headers['x-tradearena-user'] = currentUser.row.handle;
    }
    delete headers.authorization;
    delete headers['transfer-encoding'];
    if (body) {
      headers['content-length'] = String(body.length);
    }

    const requestModule = target.protocol === 'https:' ? https : http;

    const upstream = requestModule.request(target, { method: req.method, headers }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, {
        ...upstreamRes.headers,
        'access-control-allow-origin': '*',
      });
      upstreamRes.pipe(res);
    });

    upstream.on('error', (error) => {
      metrics.errors += 1;
      json(res, 502, { error: 'backend unavailable', detail: error.message });
    });

    if (body) {
      upstream.end(body);
    } else {
      req.pipe(upstream);
    }
    metrics.proxied += 1;
  };

  if (req.method === 'GET' || req.method === 'HEAD') {
    send();
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => send(Buffer.concat(chunks)));
}

function metricsText() {
  const uptime = Math.floor((Date.now() - metrics.startedAt) / 1000);
  return [
    '# HELP tradearena_gateway_uptime_seconds Gateway uptime in seconds',
    '# TYPE tradearena_gateway_uptime_seconds counter',
    `tradearena_gateway_uptime_seconds ${uptime}`,
    '# HELP tradearena_gateway_requests_total Total HTTP requests',
    '# TYPE tradearena_gateway_requests_total counter',
    `tradearena_gateway_requests_total ${metrics.requests}`,
    `tradearena_gateway_proxied_requests_total ${metrics.proxied}`,
    `tradearena_gateway_rate_limited_total ${metrics.rateLimited}`,
    `tradearena_gateway_errors_total ${metrics.errors}`,
    `tradearena_gateway_ws_connections_total ${metrics.wsConnections}`,
    `tradearena_gateway_ws_messages_total ${metrics.wsMessages}`,
    '',
  ].join('\n');
}

function wsFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function broadcast(type, data) {
  const frame = wsFrame(JSON.stringify({ type, data, ts: Date.now() }));
  for (const socket of clients) {
    if (!socket.destroyed) {
      socket.write(frame);
      metrics.wsMessages += 1;
    }
  }
}

function connectMarketDataStream() {
  const requestModule = BACKEND_URL.startsWith('https') ? https : http;
  
  const req = requestModule.get(`${BACKEND_URL}/api/events`, (res) => {
    res.setEncoding('utf8');
    let buffer = '';
    let event = 'message';
    res.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const lines = part.split('\n');
        const eventLine = lines.find((line) => line.startsWith('event: '));
        const dataLine = lines.find((line) => line.startsWith('data: '));
        if (eventLine) {
          event = eventLine.slice(7);
        }
        if (dataLine) {
          try {
            broadcast(event, JSON.parse(dataLine.slice(6)));
          } catch {
            broadcast(event, dataLine.slice(6));
          }
        }
      }
    });
    res.on('end', () => setTimeout(connectMarketDataStream, 1000));
  });
  req.on('error', () => setTimeout(connectMarketDataStream, 1000));
}

const server = http.createServer((req, res) => {
  metrics.requests += 1;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,x-tradearena-user,authorization',
    });
    res.end();
    return;
  }

  if (rateLimited(req)) {
    metrics.rateLimited += 1;
    json(res, 429, { error: 'rate limit exceeded' });
    return;
  }

  if (req.url.startsWith('/auth/') || req.url === '/me') {
    handleAuth(req, res).catch((error) => {
      metrics.errors += 1;
      json(res, 500, { error: 'auth failed', detail: error.message });
    });
    return;
  }

  if (req.url.startsWith('/api/')) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const tokenFromQuery = url.searchParams.get('token');
    const authPromise = tokenFromQuery ? userFromToken(tokenFromQuery) : userFromRequest(req);
    authPromise.then((current) => {
      if (!current) {
        json(res, 401, { error: 'not authenticated' });
        return;
      }
      if (url.pathname === '/api/events') {
        proxy(req, res, current, '/api/events');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        backendJson('GET', '/api/state', current)
          .then((upstream) => persistedState(current, upstream.data))
          .then((state) => json(res, 200, state))
          .catch((error) => {
            metrics.errors += 1;
            json(res, 500, { error: 'state failed', detail: error.message });
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
        backendJson('GET', '/api/state', current)
          .then((upstream) => leaderboardRows(upstream.data))
          .then((rows) => json(res, 200, { rows }))
          .catch((error) => {
            metrics.errors += 1;
            json(res, 500, { error: 'leaderboard failed', detail: error.message });
          });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/orders') {
        readRawBody(req)
          .then((body) => backendJson('POST', '/api/orders', current, body))
          .then(async (upstream) => {
            if (upstream.data?.accepted || upstream.data?.order?.id) {
              await persistOrderAck(current, upstream.data);
            }
            json(res, upstream.status, upstream.data);
          })
          .catch((error) => {
            metrics.errors += 1;
            json(res, 500, { error: 'order failed', detail: error.message });
          });
        return;
      }
      const cancelMatch = url.pathname.match(/^\/api\/orders\/(\d+)$/);
      if (req.method === 'DELETE' && cancelMatch) {
        backendJson('DELETE', url.pathname, current)
          .then(async (upstream) => {
            if (upstream.data?.cancelled) {
              await pool.query(
                `UPDATE orders
                 SET status = 'cancelled',
                     remaining = 0,
                     updated_at = now()
                 WHERE user_id = $1 AND id = $2`,
                [current.row.id, Number(cancelMatch[1])],
              );
            }
            json(res, upstream.status, upstream.data);
          })
          .catch((error) => {
            metrics.errors += 1;
            json(res, 500, { error: 'cancel failed', detail: error.message });
          });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/reset') {
        backendJson('POST', '/api/reset', current)
          .then(async (upstream) => {
            await resetPersistentAccount(current);
            const state = await persistedState(current, upstream.data);
            json(res, upstream.status, state);
          })
          .catch((error) => {
            metrics.errors += 1;
            json(res, 500, { error: 'reset failed', detail: error.message });
          });
        return;
      }
      proxy(req, res, current);
    }).catch((error) => {
      metrics.errors += 1;
      json(res, 500, { error: 'auth proxy failed', detail: error.message });
    });
    return;
  }

  if (req.url === '/health') {
    json(res, 200, { status: 'ok', backend: BACKEND_URL });
    return;
  }

  if (req.url === '/metrics') {
    const body = metricsText();
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(body);
    return;
  }

  proxy(req, res);
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws/market-data') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  );
  clients.add(socket);
  metrics.wsConnections += 1;
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

async function waitForDatabase() {
  let lastError;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await ensureAuthSchema();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

waitForDatabase()
  .then(() => {
    server.listen(PORT, () => {
      connectMarketDataStream();
    });
  })
  .catch((error) => {
    process.exit(1);
  });