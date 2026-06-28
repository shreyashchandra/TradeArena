import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';

const emptyState = {
  account: { cash: 0, equity: 0, realizedPnl: 0, unrealizedPnl: 0 },
  quotes: [],
  positions: [],
  openOrders: [],
  fills: [],
};

function money(cents) {
  return `₹${(Number(cents) / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function qty(value) {
  return Number(value).toLocaleString();
}

function Pnl({ value }) {
  const className = value > 0 ? 'positive' : value < 0 ? 'negative' : '';
  return <span className={className}>{money(value)}</span>;
}

function SymbolSearch({ symbols, selected, onSelect }) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const normalized = query.trim().toUpperCase();
    if (!normalized) {
      return symbols.slice(0, 8);
    }
    return symbols
      .filter((symbol) => symbol.includes(normalized))
      .slice(0, 12);
  }, [query, symbols]);

  return (
    <div className="symbol-search">
      <input
        list="symbol-list"
        placeholder="Search symbol"
        value={query || selected}
        onChange={(event) => {
          const value = event.target.value.toUpperCase();
          setQuery(value);
          if (symbols.includes(value)) {
            onSelect(value);
          }
        }}
        onFocus={() => setQuery('')}
      />
      <datalist id="symbol-list">
        {matches.map((symbol) => (
          <option key={symbol} value={symbol} />
        ))}
      </datalist>
    </div>
  );
}

function QuoteGrid({
  quotes,
  selected,
  onSelect,
  search,
  onSearch,
  searchResults,
  onAddSymbol,
}) {
  const filtered = useMemo(() => {
    const normalized = search.trim().toUpperCase();
    if (!normalized) {
      return quotes;
    }
    return quotes.filter((quote) => quote.symbol.includes(normalized));
  }, [quotes, search]);

  return (
    <section className="panel quotes-panel">
      <div className="panel-header market-header">
        <div>
          <h2>Market Watch</h2>
          <span>Yahoo delayed NSE data</span>
        </div>
        <label className="market-search">
          <input
            placeholder="Search stocks"
            value={search}
            onChange={(event) => onSearch(event.target.value.toUpperCase())}
          />
        </label>
      </div>
      {search.trim() && searchResults.length > 0 && (
        <div className="search-results">
          {searchResults.map((result) => (
            <button
              key={result.yahooSymbol}
              type="button"
              onClick={() => onAddSymbol(result)}
            >
              <strong>{result.symbol}</strong>
              <span>{result.name || result.yahooSymbol}</span>
              <em>{result.exchange}</em>
            </button>
          ))}
        </div>
      )}
      <div className="quote-head">
        <span>Symbol</span>
        <span>Bid</span>
        <span>Ask</span>
        <span>Last</span>
      </div>
      {filtered.length === 0 && <div className="empty-row">No matching symbols</div>}
      {filtered.map((quote) => (
        <button
          className={`quote-row ${selected === quote.symbol ? 'selected' : ''}`}
          key={quote.symbol}
          type="button"
          onClick={() => onSelect(quote.symbol)}
        >
          <strong>{quote.symbol}</strong>
          <span>{money(quote.bid)}</span>
          <span>{money(quote.ask)}</span>
          <span>{money(quote.last)}</span>
        </button>
      ))}
      <div className="market-count">
        Showing {filtered.length} of {quotes.length} loaded symbols
      </div>
    </section>
  );
}

function OrderTicket({ symbols, selected, onSymbol, onSubmit }) {
  const [form, setForm] = useState({
    side: 'buy',
    type: 'market',
    price: '',
    quantity: '1',
  });

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit(event) {
    event.preventDefault();
    onSubmit({
      id: Date.now(),
      symbol: selected,
      side: form.side,
      type: form.type,
      price: form.type === 'market' ? 0 : Math.round(Number(form.price) * 100),
      quantity: Number(form.quantity),
    });
  }

  return (
    <form className="panel ticket" onSubmit={submit}>
      <div className="panel-header">
        <h2>Paper Order</h2>
      </div>

      <label>
        Symbol
        <SymbolSearch symbols={symbols} selected={selected} onSelect={onSymbol} />
      </label>

      <div className="segmented">
        <button
          className={form.side === 'buy' ? 'active buy' : ''}
          type="button"
          onClick={() => update('side', 'buy')}
        >
          Buy
        </button>
        <button
          className={form.side === 'sell' ? 'active sell' : ''}
          type="button"
          onClick={() => update('side', 'sell')}
        >
          Sell
        </button>
      </div>

      <label>
        Type
        <select value={form.type} onChange={(event) => update('type', event.target.value)}>
          <option value="market">Market</option>
          <option value="limit">Limit</option>
        </select>
      </label>

      <label>
        Limit price
        <input
          disabled={form.type === 'market'}
          min="0.01"
          step="0.01"
          type="number"
          value={form.price}
          onChange={(event) => update('price', event.target.value)}
        />
      </label>

      <label>
        Quantity
        <input
          min="1"
          step="1"
          type="number"
          value={form.quantity}
          onChange={(event) => update('quantity', event.target.value)}
        />
      </label>

      <button className={`submit ${form.side}`} type="submit">
        Place Paper {form.side === 'buy' ? 'Buy' : 'Sell'}
      </button>
    </form>
  );
}

function Positions({ positions }) {
  return (
    <section className="panel table-panel">
      <div className="panel-header">
        <h2>Positions</h2>
        <span>{positions.length} open</span>
      </div>
      <div className="table-head positions-grid">
        <span>Symbol</span>
        <span>Qty</span>
        <span>Avg</span>
        <span>Mark</span>
        <span>P&L</span>
      </div>
      {positions.length === 0 && <div className="empty-row">No positions</div>}
      {positions.map((position) => (
        <div className="table-row positions-grid" key={position.symbol}>
          <strong>{position.symbol}</strong>
          <span>{qty(position.quantity)}</span>
          <span>{money(position.averagePrice)}</span>
          <span>{money(position.markPrice)}</span>
          <Pnl value={position.unrealizedPnl} />
        </div>
      ))}
    </section>
  );
}

function OpenOrders({ orders, onCancel }) {
  return (
    <section className="panel table-panel">
      <div className="panel-header">
        <h2>Open Orders</h2>
        <span>{orders.length} resting</span>
      </div>
      <div className="table-head orders-grid">
        <span>ID</span>
        <span>Symbol</span>
        <span>Side</span>
        <span>Limit</span>
        <span></span>
      </div>
      {orders.length === 0 && <div className="empty-row">No open limit orders</div>}
      {orders.map((order) => (
        <div className="table-row orders-grid" key={order.id}>
          <span>#{order.id}</span>
          <strong>{order.symbol}</strong>
          <span className={order.side}>{order.side}</span>
          <span>{money(order.price)}</span>
          <button type="button" onClick={() => onCancel(order.id)}>
            Cancel
          </button>
        </div>
      ))}
    </section>
  );
}

function FillTape({ fills }) {
  const recent = [...fills].reverse().slice(0, 20);
  return (
    <section className="panel table-panel">
      <div className="panel-header">
        <h2>Fills</h2>
        <span>{fills.length} total</span>
      </div>
      {recent.length === 0 && <div className="empty-row">No fills yet</div>}
      {recent.map((fill, index) => (
        <div className="fill-row" key={`${fill.orderId}-${index}`}>
          <strong>{fill.symbol}</strong>
          <span className={fill.side}>{fill.side}</span>
          <span>{qty(fill.quantity)}</span>
          <span>{money(fill.price)}</span>
        </div>
      ))}
    </section>
  );
}

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({
    email: '',
    name: '',
    handle: '',
    login: '',
    password: '',
  });
  const [error, setError] = useState('');
  const isRegister = mode === 'register';

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    const endpoint = isRegister ? '/auth/register' : '/auth/login';
    const body = isRegister
      ? {
          email: form.email,
          name: form.name,
          handle: form.handle,
          password: form.password,
        }
      : {
          login: form.login,
          password: form.password,
        };
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error || 'Authentication failed');
      return;
    }
    window.localStorage.setItem('tradearena-auth', JSON.stringify(payload));
    onAuth(payload);
  }

  return (
    <main className="auth-shell">
      <section className="auth-copy">
        <h1>TradeArena</h1>
        <p>Practice trading with virtual cash, live-style market updates, P&L, replay, and competitions.</p>
      </section>
      <form className="panel auth-card" onSubmit={submit}>
        <div className="panel-header">
          <h2>{isRegister ? 'Create Account' : 'Login'}</h2>
          <span>Rs 10,00,000 virtual cash</span>
        </div>
        {isRegister ? (
          <>
            <label>
              Email
              <input value={form.email} onChange={(event) => update('email', event.target.value)} />
            </label>
            <label>
              Display name
              <input value={form.name} onChange={(event) => update('name', event.target.value)} />
            </label>
            <label>
              Handle
              <input value={form.handle} onChange={(event) => update('handle', event.target.value)} />
            </label>
          </>
        ) : (
          <label>
            Email or handle
            <input value={form.login} onChange={(event) => update('login', event.target.value)} />
          </label>
        )}
        <label>
          Password
          <input
            minLength="6"
            type="password"
            value={form.password}
            onChange={(event) => update('password', event.target.value)}
          />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button type="submit">{isRegister ? 'Create Account' : 'Login'}</button>
        <button className="link-button" type="button" onClick={() => setMode(isRegister ? 'login' : 'register')}>
          {isRegister ? 'Already have an account? Login' : 'New here? Create account'}
        </button>
      </form>
    </main>
  );
}

function Leaderboard({ user, rows }) {
  return (
    <section className="panel leaderboard">
      <div className="panel-header">
        <h2>Leaderboard</h2>
        <span>Weekly arena</span>
      </div>
      {rows.slice(0, 10).map((row) => (
        <div className={row.handle === user.handle ? 'leader-row active' : 'leader-row'} key={row.handle}>
          <strong>#{row.rank}</strong>
          <span>{row.name}</span>
          <em>{money(row.equity)}</em>
        </div>
      ))}
      {rows.length === 0 && <div className="empty-row">No traders yet</div>}
    </section>
  );
}

function ReplayPanel({ fills }) {
  const [cursor, setCursor] = useState(0);
  const replay = fills[cursor] ?? null;

  return (
    <section className="panel replay-panel">
      <div className="panel-header">
        <h2>Trade Replay</h2>
        <span>{fills.length} fills</span>
      </div>
      {replay ? (
        <div className="replay-body">
          <strong>{replay.symbol}</strong>
          <span className={replay.side}>{replay.side}</span>
          <span>{qty(replay.quantity)} @ {money(replay.price)}</span>
          <input
            min="0"
            max={Math.max(0, fills.length - 1)}
            type="range"
            value={cursor}
            onChange={(event) => setCursor(Number(event.target.value))}
          />
        </div>
      ) : (
        <div className="empty-row">Place trades to replay execution history</div>
      )}
    </section>
  );
}

function App() {
  const [state, setState] = useState(emptyState);
  const [leaderboard, setLeaderboard] = useState([]);
  const [status, setStatus] = useState('connecting');
  const [selected, setSelected] = useState('RELIANCE');
  const [lastMessage, setLastMessage] = useState('');
  const [marketSearch, setMarketSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [auth, setAuth] = useState(() => {
    try {
      return JSON.parse(window.localStorage.getItem('tradearena-auth'));
    } catch {
      return null;
    }
  });
  const user = auth?.user;
  const currentRank = leaderboard.find((row) => row.handle === user?.handle)?.rank;

  const symbols = useMemo(
    () => state.quotes.map((quote) => quote.symbol),
    [state.quotes],
  );

  useEffect(() => {
    if (!auth?.token) return;
    fetch(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    }).then((response) => {
      if (response.status === 401) {
        window.localStorage.removeItem('tradearena-auth');
        setAuth(null);
      }
    }).catch(() => {});
  }, [auth?.token]);

  useEffect(() => {
    if (!auth?.token) return undefined;

    const loadLeaderboard = () => {
      fetch(`${API_BASE}/api/leaderboard`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
        .then((response) => response.json())
        .then((payload) => setLeaderboard(payload.rows ?? []))
        .catch(() => setLeaderboard([]));
    };

    const loadState = () => {
      fetch(`${API_BASE}/api/state`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
        .then((response) => response.json())
        .then((next) => {
          setState(next);
          if (next.quotes[0]) {
            setSelected((current) => current || next.quotes[0].symbol);
          }
        })
        .catch(() => setStatus('offline'));
      loadLeaderboard();
    };

    loadState();

    const events = new EventSource(
      `${API_BASE}/api/events?token=${encodeURIComponent(auth.token)}`,
    );
    events.addEventListener('open', () => setStatus('live'));
    events.addEventListener('error', () => setStatus('reconnecting'));
    events.addEventListener('state', loadState);
    events.addEventListener('fill', (event) => {
      const fill = JSON.parse(event.data);
      setLastMessage(`Filled ${fill.side} ${fill.quantity} ${fill.symbol} @ ${money(fill.price)}`);
      loadState();
    });
    return () => events.close();
  }, [auth?.token]);

  useEffect(() => {
    const query = marketSearch.trim();
    if (query.length < 2) {
      setSearchResults([]);
      return undefined;
    }

    const handle = window.setTimeout(() => {
      fetch(`${API_BASE}/api/search?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
        .then((response) => response.json())
        .then((payload) => setSearchResults(payload.results ?? []))
        .catch(() => setSearchResults([]));
    }, 300);

    return () => window.clearTimeout(handle);
  }, [auth?.token, marketSearch]);

  async function submitOrder(payload) {
    const response = await fetch(`${API_BASE}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'X-TradeArena-User': user.handle,
      },
      body: JSON.stringify(payload),
    });
    const ack = await response.json();
    setLastMessage(`${ack.message}: #${payload.id}`);
  }

  async function cancelOrder(id) {
    const response = await fetch(`${API_BASE}/api/orders/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    const ack = await response.json();
    setLastMessage(ack.cancelled ? `Cancelled #${id}` : `Order #${id} not found`);
  }

  async function addSymbol(result) {
    const response = await fetch(`${API_BASE}/api/symbols`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ yahooSymbol: result.yahooSymbol }),
    });
    const payload = await response.json();
    if (payload.quote) {
      setSelected(payload.quote.symbol);
      setMarketSearch(payload.quote.symbol);
      setLastMessage(`Added ${payload.quote.symbol} from ${result.exchange}`);
    } else {
      setLastMessage(`Could not add ${result.yahooSymbol}`);
    }
  }

  async function reset() {
    await fetch(`${API_BASE}/api/reset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    setLastMessage('Paper account reset');
  }

  async function logout() {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    window.localStorage.removeItem('tradearena-auth');
    setAuth(null);
  }

  if (!auth?.token || !user) {
    return <AuthScreen onAuth={setAuth} />;
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>TradeArena</h1>
          <p>Real-time paper trading arena powered by a C++ execution core</p>
        </div>
        <div className="top-actions">
          <span>@{user.handle}</span>
          <button className="logout-button" type="button" onClick={logout}>Logout</button>
          <div className={`status ${status}`}>{status}</div>
        </div>
      </header>

      <section className="metrics">
        <div>
          <span>Cash</span>
          <strong>{money(state.account.cash)}</strong>
        </div>
        <div>
          <span>Equity</span>
          <strong>{money(state.account.equity)}</strong>
        </div>
        <div>
          <span>Unrealized P&L</span>
          <strong>
            <Pnl value={state.account.unrealizedPnl} />
          </strong>
        </div>
        <div>
          <span>Realized P&L</span>
          <strong>
            <Pnl value={state.account.realizedPnl} />
          </strong>
        </div>
        <div>
          <span>Rank</span>
          <strong>{currentRank ? `#${currentRank}` : '-'}</strong>
        </div>
      </section>

      <div className="layout">
        <section className="workspace">
          <QuoteGrid
            quotes={state.quotes}
            selected={selected}
            onSelect={setSelected}
            search={marketSearch}
            onSearch={setMarketSearch}
            searchResults={searchResults}
            onAddSymbol={addSymbol}
          />
          <Positions positions={state.positions} />
          <OpenOrders orders={state.openOrders} onCancel={cancelOrder} />
          <ReplayPanel fills={state.fills} />
        </section>

        <aside className="controls">
          <OrderTicket
            symbols={symbols.length ? symbols : ['RELIANCE']}
            selected={selected}
            onSymbol={setSelected}
            onSubmit={submitOrder}
          />
          <section className="panel action-panel">
            <div className="panel-header">
              <h2>Session</h2>
            </div>
            <button type="button" onClick={reset}>
              Reset Paper Account
            </button>
            {lastMessage && <p>{lastMessage}</p>}
          </section>
          <Leaderboard user={user} rows={leaderboard} />
          <FillTape fills={state.fills} />
        </aside>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
