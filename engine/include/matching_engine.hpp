#pragma once

#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace exchange {

using OrderId = std::uint64_t;
using Price = std::int64_t;
using Quantity = std::uint64_t;

enum class Side { Buy, Sell };
enum class OrderType { Limit, Market };
enum class TimeInForce { Gtc, Ioc };

struct OrderRequest {
  OrderId id{};
  Side side{};
  OrderType type{OrderType::Limit};
  Price price{};
  Quantity quantity{};
  TimeInForce tif{TimeInForce::Gtc};
};

struct Trade {
  OrderId taker_id{};
  OrderId maker_id{};
  Price price{};
  Quantity quantity{};
};

struct RestingOrder {
  OrderId id{};
  Side side{};
  Price price{};
  Quantity quantity{};
};

struct OrderAck {
  bool accepted{false};
  bool resting{false};
  Quantity remaining{};
  std::string message;
  std::vector<Trade> trades;
};

struct BookLevel {
  Price price{};
  Quantity quantity{};
  std::size_t order_count{};
};

struct BookSnapshot {
  std::vector<BookLevel> bids;
  std::vector<BookLevel> asks;
};

class MatchingEngine {
 public:
  using TradeCallback = std::function<void(const Trade&)>;

  explicit MatchingEngine(TradeCallback on_trade = {});

  OrderAck submit(OrderRequest request);
  bool cancel(OrderId id);

  [[nodiscard]] BookSnapshot snapshot(std::size_t depth = 10) const;
  [[nodiscard]] std::optional<RestingOrder> find(OrderId id) const;
  [[nodiscard]] std::size_t open_order_count() const;

 private:
  struct Order {
    OrderId id{};
    Side side{};
    Price price{};
    Quantity quantity{};
    std::uint64_t sequence{};
  };

  using Level = std::deque<Order>;
  using BidBook = std::map<Price, Level, std::greater<>>;
  using AskBook = std::map<Price, Level, std::less<>>;

  struct OrderLocation {
    Side side{};
    Price price{};
  };

  bool crosses(Side side, Price price) const;
  void rest(OrderRequest request, Quantity remaining);
  bool erase_from_level(OrderId id, Level& level);
  void prune_empty_level(Side side, Price price);

  BidBook bids_;
  AskBook asks_;
  std::unordered_map<OrderId, OrderLocation> index_;
  std::uint64_t sequence_{0};
  TradeCallback on_trade_;
};

const char* to_string(Side side);
const char* to_string(OrderType type);
const char* to_string(TimeInForce tif);
Side parse_side(const std::string& value);
OrderType parse_order_type(const std::string& value);
TimeInForce parse_tif(const std::string& value);

}  // namespace exchange
