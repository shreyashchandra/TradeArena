#include "paper_trading.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <cmath>
#include <cstdlib>
#include <sstream>
#include <stdexcept>

namespace paper {

namespace {

Price mid(const Quote& quote) { return (quote.bid + quote.ask) / 2; }

std::vector<SymbolDef> default_symbols() {
  return {
      {"ADANIENT", "ADANIENT.NS", 250000},
      {"ADANIPORTS", "ADANIPORTS.NS", 140000},
      {"APOLLOHOSP", "APOLLOHOSP.NS", 720000},
      {"ASIANPAINT", "ASIANPAINT.NS", 290000},
      {"AXISBANK", "AXISBANK.NS", 120000},
      {"BAJAJ-AUTO", "BAJAJ-AUTO.NS", 980000},
      {"BAJFINANCE", "BAJFINANCE.NS", 710000},
      {"BAJAJFINSV", "BAJAJFINSV.NS", 170000},
      {"BEL", "BEL.NS", 31000},
      {"BHARTIARTL", "BHARTIARTL.NS", 140000},
      {"BPCL", "BPCL.NS", 31000},
      {"BRITANNIA", "BRITANNIA.NS", 570000},
      {"CIPLA", "CIPLA.NS", 150000},
      {"COALINDIA", "COALINDIA.NS", 45000},
      {"DIVISLAB", "DIVISLAB.NS", 470000},
      {"DRREDDY", "DRREDDY.NS", 650000},
      {"EICHERMOT", "EICHERMOT.NS", 470000},
      {"GRASIM", "GRASIM.NS", 260000},
      {"HCLTECH", "HCLTECH.NS", 150000},
      {"HDFCBANK", "HDFCBANK.NS", 168000},
      {"HDFCLIFE", "HDFCLIFE.NS", 62000},
      {"HEROMOTOCO", "HEROMOTOCO.NS", 520000},
      {"HINDALCO", "HINDALCO.NS", 66000},
      {"HINDUNILVR", "HINDUNILVR.NS", 240000},
      {"ICICIBANK", "ICICIBANK.NS", 115000},
      {"INDUSINDBK", "INDUSINDBK.NS", 145000},
      {"INFY", "INFY.NS", 151000},
      {"ITC", "ITC.NS", 44000},
      {"JSWSTEEL", "JSWSTEEL.NS", 93000},
      {"KOTAKBANK", "KOTAKBANK.NS", 175000},
      {"LT", "LT.NS", 360000},
      {"M&M", "M&M.NS", 290000},
      {"MARUTI", "MARUTI.NS", 1250000},
      {"NESTLEIND", "NESTLEIND.NS", 250000},
      {"NIFTY", "^NSEI", 2350000},
      {"NTPC", "NTPC.NS", 37000},
      {"ONGC", "ONGC.NS", 27000},
      {"POWERGRID", "POWERGRID.NS", 33000},
      {"RELIANCE", "RELIANCE.NS", 132000},
      {"SBILIFE", "SBILIFE.NS", 145000},
      {"SBIN", "SBIN.NS", 83000},
      {"SHRIRAMFIN", "SHRIRAMFIN.NS", 250000},
      {"SUNPHARMA", "SUNPHARMA.NS", 155000},
      {"TATACONSUM", "TATACONSUM.NS", 110000},
      {"TATAMOTORS", "TATAMOTORS.NS", 95000},
      {"TATASTEEL", "TATASTEEL.NS", 16000},
      {"TCS", "TCS.NS", 392000},
      {"TECHM", "TECHM.NS", 135000},
      {"TITAN", "TITAN.NS", 360000},
      {"TRENT", "TRENT.NS", 520000},
      {"ULTRACEMCO", "ULTRACEMCO.NS", 1120000},
      {"WIPRO", "WIPRO.NS", 52000},
  };
}

std::optional<double> extract_number(const std::string& json,
                                     const std::string& key) {
  const auto pos = json.find("\"" + key + "\"");
  if (pos == std::string::npos) {
    return std::nullopt;
  }
  const auto colon = json.find(':', pos);
  const auto begin = json.find_first_of("-0123456789", colon);
  if (begin == std::string::npos) {
    return std::nullopt;
  }
  const auto end = json.find_first_not_of("0123456789.-", begin);
  return std::stod(json.substr(begin, end - begin));
}

std::string fetch_url(const std::string& url) {
  const std::string command =
      "curl -s --max-time 4 -A 'Mozilla/5.0' '" + url + "'";
  std::array<char, 4096> buffer{};
  std::string result;
  FILE* pipe = popen(command.c_str(), "r");
  if (!pipe) {
    return result;
  }
  while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
    result += buffer.data();
  }
  pclose(pipe);
  return result;
}

bool live_data_enabled() {
  return std::getenv("PAPER_DISABLE_LIVE_DATA") == nullptr;
}

std::string url_encode(const std::string& value) {
  std::ostringstream out;
  for (unsigned char ch : value) {
    if (std::isalnum(ch) || ch == '-' || ch == '_' || ch == '.') {
      out << ch;
    } else if (ch == ' ') {
      out << '+';
    } else {
      constexpr char hex[] = "0123456789ABCDEF";
      out << '%' << hex[ch >> 4] << hex[ch & 0x0F];
    }
  }
  return out.str();
}

bool safe_yahoo_symbol(const std::string& symbol) {
  return !symbol.empty() &&
         std::all_of(symbol.begin(), symbol.end(), [](unsigned char ch) {
           return std::isalnum(ch) || ch == '.' || ch == '-' || ch == '^' ||
                  ch == '&';
         });
}

std::optional<std::string> extract_string(const std::string& json,
                                          const std::string& key) {
  const auto pos = json.find("\"" + key + "\"");
  if (pos == std::string::npos) {
    return std::nullopt;
  }
  const auto colon = json.find(':', pos);
  const auto first = json.find('"', colon + 1);
  if (colon == std::string::npos || first == std::string::npos) {
    return std::nullopt;
  }
  std::string value;
  for (auto i = first + 1; i < json.size(); ++i) {
    if (json[i] == '"' && json[i - 1] != '\\') {
      return value;
    }
    value += json[i];
  }
  return std::nullopt;
}

std::string app_symbol_from_yahoo(const std::string& yahoo_symbol) {
  if (yahoo_symbol.size() > 3 &&
      yahoo_symbol.substr(yahoo_symbol.size() - 3) == ".NS") {
    return yahoo_symbol.substr(0, yahoo_symbol.size() - 3);
  }
  if (yahoo_symbol.size() > 3 &&
      yahoo_symbol.substr(yahoo_symbol.size() - 3) == ".BO") {
    return yahoo_symbol.substr(0, yahoo_symbol.size() - 3) + ".BO";
  }
  return yahoo_symbol;
}

}  // namespace

PaperTradingEngine::PaperTradingEngine() { reset(); }

void PaperTradingEngine::reset() {
  cash_ = 100000000;
  realized_pnl_ = 0;
  tick_count_ = 0;
  positions_.clear();
  open_orders_.clear();
  fills_.clear();
  quotes_.clear();
  yahoo_symbols_.clear();
  symbol_order_.clear();
  refresh_cursor_ = 0;

  for (const auto& symbol : default_symbols()) {
    seed_symbol(symbol);
  }
  for (std::size_t i = 0; live_data_enabled() && i < 6 &&
                          i < symbol_order_.size();
       ++i) {
    refresh_next_quote();
  }
}

OrderAck PaperTradingEngine::submit(OrderRequest request) {
  OrderAck ack;
  if (request.id == 0) {
    ack.message = "order id must be non-zero";
    return ack;
  }
  if (request.quantity == 0) {
    ack.message = "quantity must be positive";
    return ack;
  }
  if (!quotes_.contains(request.symbol)) {
    ack.message = "unknown symbol";
    return ack;
  }
  if (request.type == OrderType::Limit && request.price <= 0) {
    ack.message = "limit price must be positive";
    return ack;
  }
  const auto duplicate = std::any_of(
      open_orders_.begin(), open_orders_.end(),
      [&](const Order& order) { return order.id == request.id; });
  if (duplicate) {
    ack.message = "duplicate order id";
    return ack;
  }

  Order order{request.id, request.symbol, request.side, request.type,
              request.price, request.quantity, request.quantity, "open"};
  ack.accepted = true;

  if (should_fill(order)) {
    auto fill = execute(order);
    apply_fill(fill);
    fills_.push_back(fill);
    ack.fills.push_back(fill);
  }

  if (order.remaining == 0) {
    order.status = "filled";
  } else if (request.type == OrderType::Limit) {
    open_orders_.push_back(order);
  } else {
    order.status = "rejected";
    ack.accepted = false;
    ack.message = "market order could not be filled";
  }

  ack.order = order;
  if (ack.message.empty()) {
    ack.message = order.status;
  }
  mark_positions();
  return ack;
}

bool PaperTradingEngine::cancel(OrderId id) {
  auto it = std::find_if(open_orders_.begin(), open_orders_.end(),
                         [&](const Order& order) { return order.id == id; });
  if (it == open_orders_.end()) {
    return false;
  }
  open_orders_.erase(it);
  return true;
}

std::vector<SymbolSearchResult> PaperTradingEngine::search_symbols(
    const std::string& query) const {
  if (query.size() < 2 || !live_data_enabled()) {
    return {};
  }

  const auto url = "https://query2.finance.yahoo.com/v1/finance/search?q=" +
                   url_encode(query) + "&quotesCount=12&newsCount=0";
  const auto json = fetch_url(url);
  std::vector<SymbolSearchResult> results;

  const auto quotes_pos = json.find("\"quotes\"");
  auto cursor = json.find('{', quotes_pos);
  while (cursor != std::string::npos && results.size() < 10) {
    const auto end = json.find('}', cursor);
    if (end == std::string::npos) {
      break;
    }
    const auto object = json.substr(cursor, end - cursor + 1);
    const auto yahoo_symbol = extract_string(object, "symbol");
    const auto exchange = extract_string(object, "exchange");
    const auto quote_type = extract_string(object, "quoteType");
    const auto long_name = extract_string(object, "longname");
    const auto short_name = extract_string(object, "shortname");
    if (yahoo_symbol && exchange && safe_yahoo_symbol(*yahoo_symbol) &&
        (*exchange == "NSI" || *exchange == "BSE") &&
        (!quote_type || *quote_type == "EQUITY" || *quote_type == "INDEX")) {
      results.push_back(SymbolSearchResult{
          app_symbol_from_yahoo(*yahoo_symbol),
          *yahoo_symbol,
          long_name.value_or(short_name.value_or("")),
          *exchange == "NSI" ? "NSE" : "BSE",
      });
    }
    cursor = json.find('{', end + 1);
  }
  return results;
}

std::optional<Quote> PaperTradingEngine::add_symbol(
    const std::string& yahoo_symbol) {
  if (!safe_yahoo_symbol(yahoo_symbol)) {
    return std::nullopt;
  }

  auto symbol = app_symbol_from_yahoo(yahoo_symbol);
  if (quotes_.contains(symbol)) {
    refresh_quote_from_yahoo(symbol);
    return quotes_.at(symbol);
  }

  if (symbol.size() > 3 && symbol.substr(symbol.size() - 3) == ".BO" &&
      quotes_.contains(symbol.substr(0, symbol.size() - 3))) {
    symbol = yahoo_symbol;
  }

  seed_symbol(SymbolDef{symbol, yahoo_symbol, 10000});
  if (live_data_enabled() && !refresh_quote_from_yahoo(symbol)) {
    quotes_.erase(symbol);
    yahoo_symbols_.erase(symbol);
    symbol_order_.erase(
        std::remove(symbol_order_.begin(), symbol_order_.end(), symbol),
        symbol_order_.end());
    return std::nullopt;
  }
  return quotes_.at(symbol);
}

std::vector<Fill> PaperTradingEngine::tick() {
  ++tick_count_;
  refresh_next_quote();

  std::vector<Fill> new_fills;
  auto it = open_orders_.begin();
  while (it != open_orders_.end()) {
    if (!should_fill(*it)) {
      ++it;
      continue;
    }
    auto fill = execute(*it);
    apply_fill(fill);
    fills_.push_back(fill);
    new_fills.push_back(fill);
    it = open_orders_.erase(it);
  }

  mark_positions();
  return new_fills;
}

void PaperTradingEngine::seed_symbol(const SymbolDef& symbol) {
  if (quotes_.contains(symbol.symbol)) {
    return;
  }
  const auto spread = std::max<Price>(5, symbol.fallback_price / 10000);
  quotes_.emplace(symbol.symbol,
                  Quote{symbol.symbol, symbol.fallback_price - spread,
                        symbol.fallback_price + spread, symbol.fallback_price, 0});
  yahoo_symbols_[symbol.symbol] = symbol.yahoo_symbol;
  symbol_order_.push_back(symbol.symbol);
}

void PaperTradingEngine::refresh_next_quote() {
  if (symbol_order_.empty() || !live_data_enabled()) {
    return;
  }
  const auto symbol = symbol_order_[refresh_cursor_ % symbol_order_.size()];
  ++refresh_cursor_;
  refresh_quote_from_yahoo(symbol);
}

bool PaperTradingEngine::refresh_quote_from_yahoo(const std::string& symbol) {
  const auto yahoo = yahoo_symbols_.find(symbol);
  const auto quote = quotes_.find(symbol);
  if (yahoo == yahoo_symbols_.end() || quote == quotes_.end()) {
    return false;
  }

  const auto url = "https://query2.finance.yahoo.com/v8/finance/chart/" +
                   yahoo->second + "?range=1d&interval=1m";
  const auto json = fetch_url(url);
  const auto price = extract_number(json, "regularMarketPrice");
  if (!price) {
    return false;
  }

  const auto previous = extract_number(json, "chartPreviousClose");
  const auto old_last = quote->second.last;
  quote->second.last = static_cast<Price>(std::llround(*price * 100.0));
  const auto spread = std::max<Price>(5, quote->second.last / 10000);
  quote->second.bid = quote->second.last - spread;
  quote->second.ask = quote->second.last + spread;
  if (previous && *previous > 0) {
    const auto previous_paise = static_cast<Price>(std::llround(*previous * 100.0));
    quote->second.change_bps =
        ((quote->second.last - previous_paise) * 10000) / previous_paise;
  } else if (old_last > 0) {
    quote->second.change_bps =
        ((quote->second.last - old_last) * 10000) / old_last;
  }
  return true;
}

State PaperTradingEngine::state() const {
  State result;
  result.account.cash = cash_;
  result.account.realized_pnl = realized_pnl_;
  result.open_orders = open_orders_;
  result.fills = fills_;

  for (const auto& [_, quote] : quotes_) {
    result.quotes.push_back(quote);
  }
  std::sort(result.quotes.begin(), result.quotes.end(),
            [](const Quote& left, const Quote& right) {
              return left.symbol < right.symbol;
            });

  for (const auto& [symbol, lot] : positions_) {
    const auto quote = quotes_.at(symbol);
    const auto mark = mid(quote);
    const auto pnl = (mark - lot.average_price) * lot.quantity;
    result.positions.push_back(
        Position{symbol, lot.quantity, lot.average_price, mark, pnl});
    result.account.unrealized_pnl += pnl;
  }
  std::sort(result.positions.begin(), result.positions.end(),
            [](const Position& left, const Position& right) {
              return left.symbol < right.symbol;
            });

  result.account.equity =
      result.account.cash + result.account.unrealized_pnl;
  return result;
}

bool PaperTradingEngine::should_fill(const Order& order) const {
  const auto quote = quotes_.at(order.symbol);
  if (order.type == OrderType::Market) {
    return true;
  }
  if (order.side == Side::Buy) {
    return quote.ask <= order.price;
  }
  return quote.bid >= order.price;
}

Fill PaperTradingEngine::execute(Order& order) {
  const auto quote = quotes_.at(order.symbol);
  const auto price = order.side == Side::Buy ? quote.ask : quote.bid;
  const auto quantity = order.remaining;
  order.remaining = 0;
  order.status = "filled";
  return Fill{order.id, order.symbol, order.side, price, quantity};
}

void PaperTradingEngine::apply_fill(const Fill& fill) {
  auto& position = positions_[fill.symbol];
  const auto signed_qty =
      fill.side == Side::Buy ? static_cast<std::int64_t>(fill.quantity)
                             : -static_cast<std::int64_t>(fill.quantity);
  cash_ -= signed_qty * fill.price;

  if (position.quantity == 0 ||
      (position.quantity > 0 && signed_qty > 0) ||
      (position.quantity < 0 && signed_qty < 0)) {
    const auto old_notional = position.average_price * position.quantity;
    const auto new_notional = fill.price * signed_qty;
    position.quantity += signed_qty;
    position.average_price =
        position.quantity == 0
            ? 0
            : static_cast<Price>((old_notional + new_notional) /
                                 position.quantity);
    return;
  }

  const auto closing_qty =
      std::min<std::int64_t>(std::llabs(position.quantity), std::llabs(signed_qty));
  const auto direction = position.quantity > 0 ? 1 : -1;
  realized_pnl_ += (fill.price - position.average_price) * closing_qty * direction;
  position.quantity += signed_qty;
  if (position.quantity == 0) {
    position.average_price = 0;
  } else if ((position.quantity > 0 && signed_qty > 0) ||
             (position.quantity < 0 && signed_qty < 0)) {
    position.average_price = fill.price;
  }
}

void PaperTradingEngine::mark_positions() {
  std::vector<std::string> empty;
  for (const auto& [symbol, lot] : positions_) {
    if (lot.quantity == 0) {
      empty.push_back(symbol);
    }
  }
  for (const auto& symbol : empty) {
    positions_.erase(symbol);
  }
}

const char* to_string(Side side) { return side == Side::Buy ? "buy" : "sell"; }

const char* to_string(OrderType type) {
  return type == OrderType::Market ? "market" : "limit";
}

Side parse_side(const std::string& value) {
  if (value == "buy") {
    return Side::Buy;
  }
  if (value == "sell") {
    return Side::Sell;
  }
  throw std::invalid_argument("side must be buy or sell");
}

OrderType parse_order_type(const std::string& value) {
  if (value == "market") {
    return OrderType::Market;
  }
  if (value == "limit") {
    return OrderType::Limit;
  }
  throw std::invalid_argument("type must be market or limit");
}

}  // namespace paper
