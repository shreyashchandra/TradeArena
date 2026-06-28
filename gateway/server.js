const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const BACKEND_URL = 'https://tradearena-backend.onrender.com';
const DATA_FILE = process.env.DATA_FILE || path.join('/tmp', 'tradearena-gateway.json');
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 240);

const STARTING_CASH = 100000000;
const clients = new Set();
const buckets = new Map();
const sessions = new Map();
const metrics = {
  startedAt: Date.now(),
  requests: 0,
  proxied: 0,
  rateLimited: 0,
  wsConnections: 0,
  wsMessages: 0,
  errors: 0,
};

const db = loadStore();

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {
      users: [],
      accounts: [],
      orders: [],
      fills: [],
      positions: [],
    };
  }
}

function saveStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
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

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    name: row.displayName,
  };
}

function accountFor(userId) {
  let account = db.accounts.find((row) => row.userId === userId);
  if (!account) {
    account = { userId, cash: STARTING_CASH, realizedPnl: 0 };
    db.accounts.push(account);
    saveStore();
  }
  return account;
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

function userFromToken(token) {
  const session = sessions.get(token);
  if (!session) return null;
  const row = db.users.find((user) => user.id === session.userId);
  if (!row) {
    sessions.delete(token);
    return null;
  }
  return { token, row, account: accountFor(row.id) };
}

function userFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return userFromToken(token);
}

async function handleAuth(req, res) {
  if (req.method === 'POST' && req.url === '/auth/register') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const handle = String(body.handle || '').trim().toLowerCase().replace(/\s+/g, '');
    const displayName = String(body.name || '').trim();
    const password = String(body.password || '');
    if (!email.includes('@') || handle.length < 3 || displayName.length < 2 || password.length < 6) {
      json(res, 400, { error: 'enter valid email, name, handle, and 6+ character password' });
      return;
    }
    if (db.users.some((user) => user.email === email || user.handle === handle)) {
      json(res, 409, { error: 'email or handle already exists' });
      return;
    }
    const row = {
      id: crypto.randomUUID(),
      email,
      handle,
      displayName,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    db.users.push(row);
    accountFor(row.id);
    saveStore();
    const token = createToken(row.id);
    json(res, 201, { token, user: publicUser(row), account: { cash: STARTING_CASH, realizedPnl: 0 } });
    return;
  }

  if (req.method === 'POST' && req.url === '/auth/login') {
    const body = await readBody(req);
    const login = String(body.login || '').trim().toLowerCase();
    const password = String(body.password || '');
    const row = db.users.find((user) => user.email === login || user.handle === login);
    if (!row || !verifyPassword(password, row.passwordHash)) {
      json(res, 401, { error: 'invalid login or password' });
      return;
    }
    const account = accountFor(row.id);
    const token = createToken(row.id);
    json(res, 200, {
      token,
      user: publicUser(row),
      account: { cash: account.cash, realizedPnl: account.realizedPnl },
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/auth/logout') {
    const current = userFromRequest(req);
    if (current) sessions.delete(current.token);
    json(res, 200, { logout: true });
    return;
  }

  if (req.method === 'GET' && req.url === '/me') {
    const current = userFromRequest(req);
    if (!current) {
      json(res, 401, { error: 'not authenticated' });
      return;
    }
    json(res, 200, {
      user: publicUser(current.row),
      account: { cash: current.account.cash, realizedPnl: current.account.realizedPnl },
    });
    return;
  }

  json(res, 404, { error: 'not found' });
}

function requestBackend(method, requestPath, currentUser, body = null) {
  return new Promise((resolve, reject) => {
    const target = new URL(requestPath, BACKEND_URL);
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
          resolve({ status: upstreamRes.statusCode || 502, data: text ? JSON.parse(text) : null, text });
        } catch (error) {
          reject(error);
        }
      });
    });
    upstream.on('error', reject);
    upstream.end(body || undefined);
  });
}

function quoteMap(quotes) {
  const map = new Map();
  for (const quote of quotes || []) map.set(quote.symbol, quote);
  return map;
}

function stateFor(current, backendState) {
  const account = accountFor(current.row.id);
  const quotesBySymbol = quoteMap(backendState.quotes);
  let unrealizedPnl = 0;
  const positions = db.positions
    .filter((position) => position.userId === current.row.id && position.quantity !== 0)
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
    .map((position) => {
      const quote = quotesBySymbol.get(position.symbol);
      const markPrice = quote ? Math.round((Number(quote.bid) + Number(quote.ask)) / 2) : position.averagePrice;
      const positionPnl = (markPrice - position.averagePrice) * position.quantity;
      unrealizedPnl += positionPnl;
      return { ...position, markPrice, unrealizedPnl: positionPnl };
    })
    .map(({ userId, ...position }) => position);

  const openOrders = db.orders
    .filter((order) => order.userId === current.row.id && order.status === 'open')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(({ userId, createdAt, updatedAt, ...order }) => order);

  const fills = db.fills
    .filter((fill) => fill.userId === current.row.id)
    .sort((left, right) => right.executedAt.localeCompare(left.executedAt))
    .slice(0, 50)
    .map(({ userId, executedAt, ...fill }) => fill);

  return {
    ...backendState,
    account: {
      cash: account.cash,
      equity: account.cash + unrealizedPnl,
      realizedPnl: account.realizedPnl,
      unrealizedPnl,
    },
    positions,
    openOrders,
    fills,
  };
}

function applyFill(userId, fill) {
  const symbol = String(fill.symbol);
  const side = String(fill.side);
  const price = Number(fill.price);
  const quantity = Number(fill.quantity);
  const signedQuantity = side === 'buy' ? quantity : -quantity;
  const account = accountFor(userId);
  let position = db.positions.find((row) => row.userId === userId && row.symbol === symbol);
  if (!position) {
    position = { userId, symbol, quantity: 0, averagePrice: 0 };
    db.positions.push(position);
  }

  const oldQuantity = position.quantity;
  const oldAverage = position.averagePrice;
  const newQuantity = oldQuantity + signedQuantity;
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
    if (newQuantity === 0) newAverage = 0;
    if ((newQuantity > 0 && signedQuantity > 0) || (newQuantity < 0 && signedQuantity < 0)) newAverage = price;
  }

  account.cash -= signedQuantity * price;
  account.realizedPnl += realizedDelta;
  position.quantity = newQuantity;
  position.averagePrice = newAverage;
  if (position.quantity === 0) {
    db.positions = db.positions.filter((row) => row !== position);
  }
  db.fills.push({
    orderId: Number(fill.orderId),
    userId,
    symbol,
    side,
    price,
    quantity,
    executedAt: new Date().toISOString(),
  });
}

function persistAck(current, ack) {
  if (!ack?.order?.id) return;
  const order = ack.order;
  const stored = {
    id: Number(order.id),
    userId: current.row.id,
    symbol: String(order.symbol),
    side: String(order.side),
    type: String(order.type),
    price: Number(order.price || 0),
    quantity: Number(order.quantity || 0),
    remaining: Number(order.remaining || 0),
    status: String(order.status || (ack.accepted ? 'open' : 'rejected')),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.orders = db.orders.filter((row) => !(row.userId === stored.userId && row.id === stored.id));
  db.orders.push(stored);
  for (const fill of ack.fills || []) applyFill(current.row.id, fill);
  saveStore();
}

function resetAccount(current) {
  const account = accountFor(current.row.id);
  account.cash = STARTING_CASH;
  account.realizedPnl = 0;
  db.orders = db.orders.filter((row) => row.userId !== current.row.id);
  db.fills = db.fills.filter((row) => row.userId !== current.row.id);
  db.positions = db.positions.filter((row) => row.userId !== current.row.id);
  saveStore();
}

function leaderboardRows(backendState) {
  const quotesBySymbol = quoteMap(backendState.quotes);
  return db.users
    .map((user) => {
      const account = accountFor(user.id);
      let unrealizedPnl = 0;
      for (const position of db.positions.filter((row) => row.userId === user.id)) {
        const quote = quotesBySymbol.get(position.symbol);
        const markPrice = quote ? Math.round((Number(quote.bid) + Number(quote.ask)) / 2) : position.averagePrice;
        unrealizedPnl += (markPrice - position.averagePrice) * position.quantity;
      }
      return {
        name: user.displayName,
        handle: user.handle,
        cash: account.cash,
        realizedPnl: account.realizedPnl,
        unrealizedPnl,
        equity: account.cash + unrealizedPnl,
      };
    })
    .sort((left, right) => right.equity - left.equity)
    .map((row, index) => ({ ...row, rank: index + 1 }));
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
  const requestModule = target.protocol === 'https:' ? https : http;
  const send = (body = null) => {
    const headers = { ...req.headers, host: target.host };
    if (currentUser) headers['x-tradearena-user'] = currentUser.row.handle;
    delete headers.authorization;
    delete headers['transfer-encoding'];
    if (body) headers['content-length'] = String(body.length);

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
    if (body) upstream.end(body);
    else req.pipe(upstream);
    metrics.proxied += 1;
  };

  if (req.method === 'GET' || req.method === 'HEAD') {
    send();
    return;
  }
  readRawBody(req).then(send).catch((error) => json(res, 400, { error: error.message }));
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
    '',
  ].join('\n');
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
    const current = tokenFromQuery ? userFromToken(tokenFromQuery) : userFromRequest(req);
    if (!current) {
      json(res, 401, { error: 'not authenticated' });
      return;
    }

    if (url.pathname === '/api/events') {
      proxy(req, res, current, '/api/events');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      requestBackend('GET', '/api/state', current)
        .then((upstream) => json(res, 200, stateFor(current, upstream.data)))
        .catch((error) => json(res, 500, { error: 'state failed', detail: error.message }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
      requestBackend('GET', '/api/state', current)
        .then((upstream) => json(res, 200, { rows: leaderboardRows(upstream.data) }))
        .catch((error) => json(res, 500, { error: 'leaderboard failed', detail: error.message }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/orders') {
      readRawBody(req)
        .then((body) => requestBackend('POST', '/api/orders', current, body))
        .then((upstream) => {
          if (upstream.data?.accepted || upstream.data?.order?.id) persistAck(current, upstream.data);
          json(res, upstream.status, upstream.data);
        })
        .catch((error) => json(res, 500, { error: 'order failed', detail: error.message }));
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/orders\/(\d+)$/);
    if (req.method === 'DELETE' && cancelMatch) {
      requestBackend('DELETE', url.pathname, current)
        .then((upstream) => {
          if (upstream.data?.cancelled) {
            const id = Number(cancelMatch[1]);
            const order = db.orders.find((row) => row.userId === current.row.id && row.id === id);
            if (order) {
              order.status = 'cancelled';
              order.remaining = 0;
              order.updatedAt = new Date().toISOString();
              saveStore();
            }
          }
          json(res, upstream.status, upstream.data);
        })
        .catch((error) => json(res, 500, { error: 'cancel failed', detail: error.message }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      requestBackend('POST', '/api/reset', current)
        .then((upstream) => {
          resetAccount(current);
          json(res, upstream.status, stateFor(current, upstream.data));
        })
        .catch((error) => json(res, 500, { error: 'reset failed', detail: error.message }));
      return;
    }

    proxy(req, res, current);
    return;
  }

  if (req.url === '/health') {
    json(res, 200, { status: 'ok', backend: BACKEND_URL, storage: 'json-file' });
    return;
  }

  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(metricsText());
    return;
  }

  proxy(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`tradearena gateway listening on http://0.0.0.0:${PORT}`);
});
