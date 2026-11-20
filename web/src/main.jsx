import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';
const STARTING_CASH = 100000000; // Rs 10,00,000 in paise

const emptyState = {
  account: { cash: 0, equity: 0, realizedPnl: 0, unrealizedPnl: 0 },
  quotes: [],
  positions: [],
  openOrders: [],
  fills: [],
};

/* ---------- formatting ---------- */

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function money(cents) {
  return `₹${inr.format(Number(cents || 0) / 100)}`;
}

function signedMoney(cents) {
  const value = Number(cents || 0);
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${money(Math.abs(value))}`;
}

function pct(value) {
  const n = Number(value || 0);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`;
}

function qty(value) {
  return Number(value || 0).toLocaleString('en-IN');
}

function tone(value) {
  return value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral';
}

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
}

/* ---------- small hooks ---------- */

function usePrevious(value) {
  const ref = useRef();
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return window.localStorage.getItem('tradearena-theme') || 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('tradearena-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((current) => [...current.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 4200);
  }, []);
  const dismiss = useCallback((id) => setToasts((current) => current.filter((t) => t.id !== id)), []);
  return { toasts, push, dismiss };
}

/* ---------- icons ---------- */

const Icon = {
  search: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  minus: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M5 12h14" />
    </svg>
  ),
  prev: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="m15 18-6-6 6-6" />
    </svg>
  ),
  next: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="m9 18 6-6-6-6" />
    </svg>
  ),
};

function Logo() {
  return (
    <div className="logo">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <path d="M7 21l6-6 4 4 8-9" fill="none" stroke="var(--accent-ink)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>TradeArena</span>
    </div>
  );
}

/* ---------- shared bits ---------- */

function Change({ bps }) {
  const value = Number(bps || 0) / 100;
  return <span className={`chip ${tone(value)}`}>{pct(value)}</span>;
}

function SideTag({ side }) {
  return <span className={`side-tag ${side}`}>{side}</span>;
}

function Empty({ title, hint }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
    </div>
  );
}

/* ---------- market watch ---------- */

function QuoteRow({ quote, selected, onSelect }) {
  const previous = usePrevious(quote.last);
  const [flash, setFlash] = useState('');
  useEffect(() => {
    if (previous === undefined || previous === quote.last) return undefined;
    setFlash(quote.last > previous ? 'flash-up' : 'flash-down');
    const handle = window.setTimeout(() => setFlash(''), 700);
    return () => window.clearTimeout(handle);
  }, [quote.last, previous]);

  return (
    <button
      className={`quote-row ${selected ? 'selected' : ''} ${flash}`}
      type="button"
      onClick={() => onSelect(quote.symbol)}
    >
      <strong className="sym">{quote.symbol}</strong>
      <span className="num last">{money(quote.last)}</span>
      <span className="num"><Change bps={quote.changeBps} /></span>
      <span className="num dim hide-sm">{money(quote.bid)}</span>
      <span className="num dim hide-sm">{money(quote.ask)}</span>
    </button>
  );
}

function MarketWatch({ quotes, selected, onSelect, search, onSearch, searchResults, onAddSymbol }) {
  const filtered = useMemo(() => {
    const normalized = search.trim().toUpperCase();
    if (!normalized) return quotes;
    return quotes.filter((quote) => quote.symbol.includes(normalized));
  }, [quotes, search]);

  const loaded = useMemo(() => new Set(quotes.map((q) => q.symbol)), [quotes]);
  const remote = searchResults.filter((r) => !loaded.has(r.symbol));

  return (
    <section className="panel market">
      <header className="panel-header">
        <div className="title">
          <h2>Market Watch</h2>
          <span className="sub">Delayed NSE · {quotes.length} symbols</span>
        </div>
      </header>
      <div className="searchbar">
        {Icon.search}
        <input
          aria-label="Search stocks"
          placeholder="Search or add a stock (e.g. TCS)"
          value={search}
          onChange={(event) => onSearch(event.target.value.toUpperCase())}
        />
        {search && (
          <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => onSearch('')}>
            {Icon.close}
          </button>
        )}
      </div>

      {search.trim() && remote.length > 0 && (
        <div className="search-results">
          <div className="results-label">Add to watchlist</div>
          {remote.map((result) => (
            <button key={result.yahooSymbol} type="button" onClick={() => onAddSymbol(result)}>
              <span className="add-icon">{Icon.plus}</span>
              <strong>{result.symbol}</strong>
              <span className="name">{result.name || result.yahooSymbol}</span>
              <em>{result.exchange}</em>
            </button>
          ))}
        </div>
      )}

      <div className="quote-head">
        <span>Symbol</span>
        <span className="num">Last</span>
        <span className="num">Chg</span>
        <span className="num hide-sm">Bid</span>
        <span className="num hide-sm">Ask</span>
      </div>
      <div className="quote-list">
        {quotes.length === 0 && <Empty title="Loading quotes…" />}
        {quotes.length > 0 && filtered.length === 0 && (
          <Empty title="No loaded symbol matches" hint="Pick one from the results above to add it." />
        )}
        {filtered.map((quote) => (
          <QuoteRow key={quote.symbol} quote={quote} selected={selected === quote.symbol} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}

/* ---------- order ticket ---------- */

function OrderTicket({ quote, cash, position, onSubmit }) {
  const [side, setSide] = useState('buy');
  const [type, setType] = useState('market');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [busy, setBusy] = useState(false);

  const symbol = quote?.symbol;
  useEffect(() => {
    setPrice('');
  }, [symbol]);

  const refPrice = type === 'limit'
    ? Math.round(Number(price || 0) * 100)
    : side === 'buy' ? quote?.ask ?? 0 : quote?.bid ?? 0;
  const qtyNum = Math.max(0, Math.floor(Number(quantity) || 0));
  const estimate = refPrice * qtyNum;
  const maxBuy = refPrice > 0 ? Math.floor(cash / refPrice) : 0;
  const held = position?.quantity ?? 0;

  let problem = '';
  if (!symbol) problem = 'Select a symbol';
  else if (qtyNum < 1) problem = 'Enter a quantity';
  else if (type === 'limit' && refPrice <= 0) problem = 'Enter a limit price';
  else if (side === 'buy' && estimate > cash) problem = 'Insufficient cash';

  async function submit(event) {
    event.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    try {
      await onSubmit({
        id: Date.now(),
        symbol,
        side,
        type,
        price: type === 'market' ? 0 : refPrice,
        quantity: qtyNum,
      });
    } finally {
      setBusy(false);
    }
  }

  function step(delta) {
    setQuantity(String(Math.max(1, qtyNum + delta)));
  }

  return (
    <form className={`panel ticket side-${side}`} onSubmit={submit}>
      <div className="side-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={side === 'buy'} className={side === 'buy' ? 'active buy' : ''} onClick={() => setSide('buy')}>
          Buy
        </button>
        <button type="button" role="tab" aria-selected={side === 'sell'} className={side === 'sell' ? 'active sell' : ''} onClick={() => setSide('sell')}>
          Sell
        </button>
      </div>

      <div className="ticket-quote">
        {quote ? (
          <>
            <div className="tq-top">
              <strong>{quote.symbol}</strong>
              <Change bps={quote.changeBps} />
            </div>
            <div className="tq-price">{money(quote.last)}</div>
            <div className="tq-book">
              <button type="button" onClick={() => { setType('limit'); setPrice((quote.bid / 100).toFixed(2)); }}>
                <span>Bid</span>
                <b className="negative">{money(quote.bid)}</b>
              </button>
              <button type="button" onClick={() => { setType('limit'); setPrice((quote.ask / 100).toFixed(2)); }}>
                <span>Ask</span>
                <b className="positive">{money(quote.ask)}</b>
              </button>
            </div>
          </>
        ) : (
          <Empty title="Pick a symbol" hint="Choose a stock from Market Watch." />
        )}
      </div>

      <div className="field">
        <span className="label">Order type</span>
        <div className="segmented">
          {['market', 'limit'].map((t) => (
            <button key={t} type="button" className={type === t ? 'active' : ''} onClick={() => setType(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {type === 'limit' && (
        <label className="field">
          <span className="label">Limit price (₹)</span>
          <input
            inputMode="decimal"
            min="0.01"
            step="0.05"
            type="number"
            placeholder={quote ? (quote.last / 100).toFixed(2) : '0.00'}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
        </label>
      )}

      <div className="field">
        <span className="label">
          Quantity
          <em>{side === 'buy' ? `Max ${qty(maxBuy)}` : `Held ${qty(held)}`}</em>
        </span>
        <div className="stepper">
          <button type="button" aria-label="Decrease" onClick={() => step(-1)}>{Icon.minus}</button>
          <input
            inputMode="numeric"
            min="1"
            step="1"
            type="number"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
          <button type="button" aria-label="Increase" onClick={() => step(1)}>{Icon.plus}</button>
        </div>
        <div className="quick-qty">
          {[1, 10, 50, 100].map((n) => (
            <button key={n} type="button" onClick={() => setQuantity(String(n))}>{n}</button>
          ))}
          {side === 'sell' && held > 0 && (
            <button type="button" onClick={() => setQuantity(String(held))}>All</button>
          )}
        </div>
      </div>

      <dl className="summary">
        <div>
          <dt>{type === 'market' ? 'Est. price' : 'Limit'}</dt>
          <dd>{refPrice ? money(refPrice) : '—'}</dd>
        </div>
        <div>
          <dt>Est. {side === 'buy' ? 'cost' : 'proceeds'}</dt>
          <dd><b>{money(estimate)}</b></dd>
        </div>
        <div>
          <dt>Cash available</dt>
          <dd>{money(cash)}</dd>
        </div>
      </dl>

      <button className={`submit ${side}`} type="submit" disabled={Boolean(problem) || busy}>
        {busy ? 'Placing…' : problem || `${side === 'buy' ? 'Buy' : 'Sell'} ${qtyNum} ${symbol}`}
      </button>
    </form>
  );
}

/* ---------- account tables ---------- */

function PositionsTable({ positions, onSelect }) {
  if (positions.length === 0) {
    return <Empty title="No open positions" hint="Place a buy order to open your first position." />;
  }
  return (
    <div className="table">
      <div className="t-head positions-grid">
        <span>Symbol</span>
        <span className="num">Qty</span>
        <span className="num hide-sm">Avg</span>
        <span className="num hide-sm">Mark</span>
        <span className="num">P&amp;L</span>
      </div>
      {positions.map((p) => {
        const cost = p.averagePrice * p.quantity;
        const ret = cost ? (p.unrealizedPnl / cost) * 100 : 0;
        return (
          <button type="button" className="t-row positions-grid" key={p.symbol} onClick={() => onSelect(p.symbol)}>
            <strong className="sym">{p.symbol}</strong>
            <span className="num">{qty(p.quantity)}</span>
            <span className="num dim hide-sm">{money(p.averagePrice)}</span>
            <span className="num hide-sm">{money(p.markPrice)}</span>
            <span className={`num pnl ${tone(p.unrealizedPnl)}`}>
              {signedMoney(p.unrealizedPnl)}
              <small>{pct(ret)}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function OrdersTable({ orders, onCancel }) {
  if (orders.length === 0) {
    return <Empty title="No open orders" hint="Resting limit orders show up here." />;
  }
  return (
    <div className="table">
      <div className="t-head orders-grid">
        <span className="hide-sm">ID</span>
        <span>Symbol</span>
        <span>Side</span>
        <span className="num">Qty</span>
        <span className="num">Limit</span>
        <span />
      </div>
      {orders.map((o) => (
        <div className="t-row orders-grid" key={o.id}>
          <span className="dim mono hide-sm">#{String(o.id).slice(-6)}</span>
          <strong className="sym">{o.symbol}</strong>
          <span><SideTag side={o.side} /></span>
          <span className="num">{qty(o.remaining ?? o.quantity)}</span>
          <span className="num">{money(o.price)}</span>
          <span className="num">
            <button type="button" className="ghost-btn danger" onClick={() => onCancel(o.id)}>Cancel</button>
          </span>
        </div>
      ))}
    </div>
  );
}

function FillsTable({ fills }) {
  const recent = useMemo(() => [...fills].reverse().slice(0, 50), [fills]);
  if (recent.length === 0) {
    return <Empty title="No fills yet" hint="Executed trades will appear here." />;
  }
  return (
    <div className="table">
      <div className="t-head fills-grid">
        <span>Symbol</span>
        <span>Side</span>
        <span className="num">Qty</span>
        <span className="num">Price</span>
        <span className="num hide-sm">Value</span>
      </div>
      {recent.map((f, i) => (
        <div className="t-row fills-grid" key={`${f.orderId}-${i}`}>
          <strong className="sym">{f.symbol}</strong>
          <span><SideTag side={f.side} /></span>
          <span className="num">{qty(f.quantity)}</span>
          <span className="num">{money(f.price)}</span>
          <span className="num dim hide-sm">{money(f.price * f.quantity)}</span>
        </div>
      ))}
    </div>
  );
}

function ReplayView({ fills }) {
  const [cursor, setCursor] = useState(0);
  const last = Math.max(0, fills.length - 1);
  const index = Math.min(cursor, last);
  const replay = fills[index];

  if (!replay) {
    return <Empty title="Nothing to replay" hint="Place trades to step through your execution history." />;
  }
  return (
    <div className="replay">
      <div className="replay-card">
        <span className="dim">Fill {index + 1} of {fills.length}</span>
        <div className="replay-main">
          <SideTag side={replay.side} />
          <strong>{qty(replay.quantity)} {replay.symbol}</strong>
          <span>@ {money(replay.price)}</span>
        </div>
        <span className="dim">Value {money(replay.price * replay.quantity)}</span>
      </div>
      <div className="replay-controls">
        <button type="button" className="icon-btn boxed" aria-label="Previous fill" disabled={index === 0} onClick={() => setCursor(index - 1)}>
          {Icon.prev}
        </button>
        <input
          aria-label="Replay position"
          min="0"
          max={last}
          type="range"
          value={index}
          onChange={(event) => setCursor(Number(event.target.value))}
        />
        <button type="button" className="icon-btn boxed" aria-label="Next fill" disabled={index === last} onClick={() => setCursor(index + 1)}>
          {Icon.next}
        </button>
      </div>
    </div>
  );
}

function AccountTabs({ state, onCancel, onSelect }) {
  const [tab, setTab] = useState('positions');
  const tabs = [
    ['positions', 'Positions', state.positions.length],
    ['orders', 'Open Orders', state.openOrders.length],
    ['fills', 'Fills', state.fills.length],
    ['replay', 'Replay', null],
  ];
  return (
    <section className="panel account">
      <div className="tabs" role="tablist">
        {tabs.map(([key, label, count]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
            {count !== null && <span className="count">{count}</span>}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {tab === 'positions' && <PositionsTable positions={state.positions} onSelect={onSelect} />}
        {tab === 'orders' && <OrdersTable orders={state.openOrders} onCancel={onCancel} />}
        {tab === 'fills' && <FillsTable fills={state.fills} />}
        {tab === 'replay' && <ReplayView fills={state.fills} />}
      </div>
    </section>
  );
}

/* ---------- leaderboard ---------- */

function Leaderboard({ user, rows }) {
  return (
    <section className="panel leaderboard">
      <header className="panel-header">
        <div className="title">
          <h2>Leaderboard</h2>
          <span className="sub">Weekly arena</span>
        </div>
      </header>
      {rows.length === 0 && <Empty title="No traders yet" />}
      <ol>
        {rows.slice(0, 10).map((row) => {
          const ret = ((row.equity - STARTING_CASH) / STARTING_CASH) * 100;
          return (
            <li className={row.handle === user.handle ? 'me' : ''} key={row.handle}>
              <span className={`rank r${row.rank}`}>{row.rank}</span>
              <span className="who">
                <strong>{row.name}</strong>
                <small>@{row.handle}</small>
              </span>
              <span className="num">
                <b>{money(row.equity)}</b>
                <small className={tone(ret)}>{pct(ret)}</small>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ---------- auth ---------- */

function AuthScreen({ onAuth, theme, toggleTheme }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', name: '', handle: '', login: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isRegister = mode === 'register';

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const endpoint = isRegister ? '/auth/register' : '/auth/login';
    const body = isRegister
      ? { email: form.email, name: form.name, handle: form.handle, password: form.password }
      : { login: form.login, password: form.password };
    try {
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
    } catch {
      setError('Could not reach the server. Is the gateway running?');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <button type="button" className="icon-btn boxed theme-toggle" aria-label="Toggle theme" onClick={toggleTheme}>
        {theme === 'dark' ? Icon.sun : Icon.moon}
      </button>
      <section className="auth-copy">
        <Logo />
        <h1>Trade the market.<br /><span>Risk nothing.</span></h1>
        <p>Practice with ₹10,00,000 in virtual cash against delayed NSE quotes, executed by a C++ matching core.</p>
        <ul className="features">
          <li><b>Live-style quotes</b><span>Streaming prices with bid/ask and daily change</span></li>
          <li><b>Real P&amp;L</b><span>Track positions, fills, and realized gains</span></li>
          <li><b>Compete</b><span>Climb the weekly leaderboard</span></li>
        </ul>
      </section>
      <form className="panel auth-card" onSubmit={submit}>
        <div className="segmented wide">
          <button type="button" className={!isRegister ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>Log in</button>
          <button type="button" className={isRegister ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>Sign up</button>
        </div>
        <h2>{isRegister ? 'Create your account' : 'Welcome back'}</h2>
        {isRegister ? (
          <>
            <label className="field">
              <span className="label">Email</span>
              <input type="email" autoComplete="email" value={form.email} onChange={(e) => update('email', e.target.value)} />
            </label>
            <div className="field-row">
              <label className="field">
                <span className="label">Display name</span>
                <input autoComplete="name" value={form.name} onChange={(e) => update('name', e.target.value)} />
              </label>
              <label className="field">
                <span className="label">Handle</span>
                <input autoComplete="username" value={form.handle} onChange={(e) => update('handle', e.target.value)} />
              </label>
            </div>
          </>
        ) : (
          <label className="field">
            <span className="label">Email or handle</span>
            <input autoComplete="username" value={form.login} onChange={(e) => update('login', e.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="label">Password</span>
          <input
            minLength="6"
            type="password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            value={form.password}
            onChange={(e) => update('password', e.target.value)}
          />
        </label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Log in'}
        </button>
        {isRegister && <p className="fine">You start with ₹10,00,000 virtual cash.</p>}
      </form>
    </div>
  );
}

/* ---------- app ---------- */

function Toasts({ toasts, dismiss }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>{Icon.close}</button>
        </div>
      ))}
    </div>
  );
}

function UserMenu({ user, onReset, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="avatar-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="avatar">{initials(user.name || user.handle)}</span>
        <span className="hide-sm">@{user.handle}</span>
      </button>
      {open && (
        <div className="menu">
          <div className="menu-head">
            <strong>{user.name}</strong>
            <span>@{user.handle}</span>
          </div>
          <button type="button" onClick={() => { setOpen(false); onReset(); }}>Reset paper account</button>
          <button type="button" className="danger" onClick={onLogout}>Log out</button>
        </div>
      )}
    </div>
  );
}

function App() {
  const [theme, toggleTheme] = useTheme();
  const { toasts, push, dismiss } = useToasts();
  const [state, setState] = useState(emptyState);
  const [leaderboard, setLeaderboard] = useState([]);
  const [status, setStatus] = useState('connecting');
  const [selected, setSelected] = useState('RELIANCE');
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

  const selectedQuote = useMemo(
    () => state.quotes.find((q) => q.symbol === selected) ?? state.quotes[0],
    [state.quotes, selected],
  );
  const selectedPosition = state.positions.find((p) => p.symbol === selectedQuote?.symbol);

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

    const events = new EventSource(`${API_BASE}/api/events?token=${encodeURIComponent(auth.token)}`);
    events.addEventListener('open', () => setStatus('live'));
    events.addEventListener('error', () => setStatus('reconnecting'));
    events.addEventListener('state', loadState);
    events.addEventListener('fill', (event) => {
      const fill = JSON.parse(event.data);
      push(`Filled ${fill.side} ${fill.quantity} ${fill.symbol} @ ${money(fill.price)}`, fill.side);
      loadState();
    });
    return () => events.close();
  }, [auth?.token, push]);

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
    try {
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
      push(ack.message || 'Order sent', ack.accepted === false || !response.ok ? 'error' : 'info');
    } catch {
      push('Order failed: server unreachable', 'error');
    }
  }

  async function cancelOrder(id) {
    try {
      const response = await fetch(`${API_BASE}/api/orders/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      const ack = await response.json();
      push(ack.cancelled ? `Cancelled order #${String(id).slice(-6)}` : `Order #${id} not found`, ack.cancelled ? 'info' : 'error');
    } catch {
      push('Cancel failed: server unreachable', 'error');
    }
  }

  async function addSymbol(result) {
    try {
      const response = await fetch(`${API_BASE}/api/symbols`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({ yahooSymbol: result.yahooSymbol }),
      });
      const payload = await response.json();
      if (payload.quote) {
        setSelected(payload.quote.symbol);
        setMarketSearch('');
        push(`Added ${payload.quote.symbol} from ${result.exchange}`);
      } else {
        push(`Could not add ${result.yahooSymbol}`, 'error');
      }
    } catch {
      push(`Could not add ${result.yahooSymbol}`, 'error');
    }
  }

  async function reset() {
    if (!window.confirm('Reset your paper account? Positions, orders and fills will be cleared.')) return;
    await fetch(`${API_BASE}/api/reset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    push('Paper account reset');
  }

  async function logout() {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
    }).catch(() => {});
    window.localStorage.removeItem('tradearena-auth');
    setAuth(null);
  }

  if (!auth?.token || !user) {
    return <AuthScreen onAuth={setAuth} theme={theme} toggleTheme={toggleTheme} />;
  }

  const { account } = state;
  const totalPnl = account.equity - STARTING_CASH;
  const totalRet = (totalPnl / STARTING_CASH) * 100;
  const invested = Math.max(0, account.equity - account.cash);

  return (
    <div className="app">
      <header className="topbar">
        <Logo />
        <div className="top-actions">
          <span className={`status ${status}`}><i />{status}</span>
          <button type="button" className="icon-btn boxed" aria-label="Toggle theme" onClick={toggleTheme}>
            {theme === 'dark' ? Icon.sun : Icon.moon}
          </button>
          <UserMenu user={user} onReset={reset} onLogout={logout} />
        </div>
      </header>

      <main className="shell">
        <section className="metrics">
          <div className="metric hero">
            <span className="label">Portfolio value</span>
            <strong>{money(account.equity)}</strong>
            <span className={`delta ${tone(totalPnl)}`}>{signedMoney(totalPnl)} ({pct(totalRet)}) all time</span>
          </div>
          <div className="metric">
            <span className="label">Cash</span>
            <strong>{money(account.cash)}</strong>
            <div className="bar"><i style={{ width: `${account.equity ? Math.min(100, (invested / account.equity) * 100) : 0}%` }} /></div>
            <span className="hint">{money(invested)} invested</span>
          </div>
          <div className="metric">
            <span className="label">Unrealized P&amp;L</span>
            <strong className={tone(account.unrealizedPnl)}>{signedMoney(account.unrealizedPnl)}</strong>
            <span className="hint">{state.positions.length} open positions</span>
          </div>
          <div className="metric">
            <span className="label">Realized P&amp;L</span>
            <strong className={tone(account.realizedPnl)}>{signedMoney(account.realizedPnl)}</strong>
            <span className="hint">{state.fills.length} fills</span>
          </div>
          <div className="metric">
            <span className="label">Arena rank</span>
            <strong>{currentRank ? `#${currentRank}` : '—'}</strong>
            <span className="hint">of {leaderboard.length || '—'} traders</span>
          </div>
        </section>

        <div className="layout">
          <MarketWatch
            quotes={state.quotes}
            selected={selectedQuote?.symbol}
            onSelect={setSelected}
            search={marketSearch}
            onSearch={setMarketSearch}
            searchResults={searchResults}
            onAddSymbol={addSymbol}
          />
          <div className="center">
            <OrderTicket quote={selectedQuote} cash={account.cash} position={selectedPosition} onSubmit={submitOrder} />
          </div>
          <Leaderboard user={user} rows={leaderboard} />
          <AccountTabs state={state} onCancel={cancelOrder} onSelect={setSelected} />
        </div>
      </main>

      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
