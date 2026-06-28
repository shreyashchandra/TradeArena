#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace paper {

using OrderId = std::uint64_t;
using Price = std::int64_t;
using Quantity = std::uint64_t;

enum class Side { Buy, Sell };
enum class OrderType { Market, Limit };

struct Quote {
  std::string symbol;
  Price bid{};
  Price ask{};
  Price last{};
  std::int64_t change_bps{};
};

struct OrderRequest {
  OrderId id{};
  std::string symbol;
  Side side{};
  OrderType type{OrderType::Market};
  Price price{};
  Quantity quantity{};
};

struct Order {
  OrderId id{};
  std::string symbol;
  Side side{};
  OrderType type{};
  Price price{};
  Quantity quantity{};
  Quantity remaining{};
  std::string status;
};

struct Fill {
  OrderId order_id{};
  std::string symbol;
  Side side{};
  Price price{};
  Quantity quantity{};
};

struct Position {
  std::string symbol;
  std::int64_t quantity{};
  Price average_price{};
  Price mark_price{};
  std::int64_t unrealized_pnl{};
};

struct Account {
  std::int64_t cash{};
  std::int64_t equity{};
  std::int64_t realized_pnl{};
  std::int64_t unrealized_pnl{};
};

struct OrderAck {
  bool accepted{false};
  std::string message;
  Order order;
  std::vector<Fill> fills;
};

struct State {
  Account account;
  std::vector<Quote> quotes;
  std::vector<Position> positions;
  std::vector<Order> open_orders;
  std::vector<Fill> fills;
};

struct SymbolDef {
  std::string symbol;
  std::string yahoo_symbol;
  Price fallback_price{};
};

struct SymbolSearchResult {
  std::string symbol;
  std::string yahoo_symbol;
  std::string name;
  std::string exchange;
};

class PaperTradingEngine {
 public:
  PaperTradingEngine();

  OrderAck submit(OrderRequest request);
  bool cancel(OrderId id);
  std::vector<SymbolSearchResult> search_symbols(const std::string& query) const;
  std::optional<Quote> add_symbol(const std::string& yahoo_symbol);
  std::vector<Fill> tick();
  State state() const;
  void reset();

 private:
  struct Lot {
    std::int64_t quantity{};
    Price average_price{};
  };

  void seed_symbol(const SymbolDef& symbol);
  void refresh_next_quote();
  bool refresh_quote_from_yahoo(const std::string& symbol);
  bool should_fill(const Order& order) const;
  Fill execute(Order& order);
  void apply_fill(const Fill& fill);
  void mark_positions();

  std::int64_t cash_{100000000};
  std::int64_t realized_pnl_{0};
  std::unordered_map<std::string, Quote> quotes_;
  std::unordered_map<std::string, std::string> yahoo_symbols_;
  std::vector<std::string> symbol_order_;
  std::unordered_map<std::string, Lot> positions_;
  std::vector<Order> open_orders_;
  std::vector<Fill> fills_;
  std::uint64_t tick_count_{0};
  std::size_t refresh_cursor_{0};
};

const char* to_string(Side side);
const char* to_string(OrderType type);
Side parse_side(const std::string& value);
OrderType parse_order_type(const std::string& value);

}  // namespace paper
