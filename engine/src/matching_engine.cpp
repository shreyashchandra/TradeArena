#include "matching_engine.hpp"

#include <algorithm>
#include <stdexcept>

namespace exchange {

MatchingEngine::MatchingEngine(TradeCallback on_trade)
    : on_trade_(std::move(on_trade)) {}

OrderAck MatchingEngine::submit(OrderRequest request) {
  OrderAck ack;

  if (request.id == 0) {
    ack.message = "order id must be non-zero";
    return ack;
  }
  if (request.quantity == 0) {
    ack.message = "quantity must be positive";
    return ack;
  }
  if (request.type == OrderType::Limit && request.price <= 0) {
    ack.message = "limit price must be positive";
    return ack;
  }
  if (index_.find(request.id) != index_.end()) {
    ack.message = "duplicate order id";
    return ack;
  }

  ack.accepted = true;
  ack.remaining = request.quantity;

  auto match_against_asks = [&]() {
    while (ack.remaining > 0 && !asks_.empty()) {
      auto best = asks_.begin();
      if (request.type == OrderType::Limit && request.price < best->first) {
        break;
      }

      auto& queue = best->second;
      while (ack.remaining > 0 && !queue.empty()) {
        auto& maker = queue.front();
        const Quantity traded = std::min(ack.remaining, maker.quantity);
        maker.quantity -= traded;
        ack.remaining -= traded;

        Trade trade{request.id, maker.id, maker.price, traded};
        ack.trades.push_back(trade);
        if (on_trade_) {
          on_trade_(trade);
        }

        if (maker.quantity == 0) {
          index_.erase(maker.id);
          queue.pop_front();
        }
      }
      if (queue.empty()) {
        asks_.erase(best);
      } else {
        break;
      }
    }
  };

  auto match_against_bids = [&]() {
    while (ack.remaining > 0 && !bids_.empty()) {
      auto best = bids_.begin();
      if (request.type == OrderType::Limit && request.price > best->first) {
        break;
      }

      auto& queue = best->second;
      while (ack.remaining > 0 && !queue.empty()) {
        auto& maker = queue.front();
        const Quantity traded = std::min(ack.remaining, maker.quantity);
        maker.quantity -= traded;
        ack.remaining -= traded;

        Trade trade{request.id, maker.id, maker.price, traded};
        ack.trades.push_back(trade);
        if (on_trade_) {
          on_trade_(trade);
        }

        if (maker.quantity == 0) {
          index_.erase(maker.id);
          queue.pop_front();
        }
      }
      if (queue.empty()) {
        bids_.erase(best);
      } else {
        break;
      }
    }
  };

  if (request.side == Side::Buy) {
    match_against_asks();
  } else {
    match_against_bids();
  }

  if (ack.remaining > 0 && request.type == OrderType::Limit &&
      request.tif == TimeInForce::Gtc) {
    rest(request, ack.remaining);
    ack.resting = true;
  }

  ack.message = "accepted";
  return ack;
}

bool MatchingEngine::cancel(OrderId id) {
  auto found = index_.find(id);
  if (found == index_.end()) {
    return false;
  }

  const auto location = found->second;
  bool removed = false;
  if (location.side == Side::Buy) {
    auto level = bids_.find(location.price);
    removed = level != bids_.end() && erase_from_level(id, level->second);
  } else {
    auto level = asks_.find(location.price);
    removed = level != asks_.end() && erase_from_level(id, level->second);
  }

  if (removed) {
    index_.erase(found);
    prune_empty_level(location.side, location.price);
  }
  return removed;
}

BookSnapshot MatchingEngine::snapshot(std::size_t depth) const {
  BookSnapshot result;
  result.bids.reserve(depth);
  result.asks.reserve(depth);

  for (const auto& [price, queue] : bids_) {
    Quantity total = 0;
    for (const auto& order : queue) {
      total += order.quantity;
    }
    result.bids.push_back(BookLevel{price, total, queue.size()});
    if (result.bids.size() == depth) {
      break;
    }
  }

  for (const auto& [price, queue] : asks_) {
    Quantity total = 0;
    for (const auto& order : queue) {
      total += order.quantity;
    }
    result.asks.push_back(BookLevel{price, total, queue.size()});
    if (result.asks.size() == depth) {
      break;
    }
  }

  return result;
}

std::optional<RestingOrder> MatchingEngine::find(OrderId id) const {
  auto found = index_.find(id);
  if (found == index_.end()) {
    return std::nullopt;
  }

  const auto location = found->second;
  const auto find_in_level = [&](const Level& level) -> std::optional<RestingOrder> {
    for (const auto& order : level) {
      if (order.id == id) {
        return RestingOrder{order.id, order.side, order.price, order.quantity};
      }
    }
    return std::nullopt;
  };

  if (location.side == Side::Buy) {
    auto level = bids_.find(location.price);
    return level == bids_.end() ? std::nullopt : find_in_level(level->second);
  }

  auto level = asks_.find(location.price);
  return level == asks_.end() ? std::nullopt : find_in_level(level->second);
}

std::size_t MatchingEngine::open_order_count() const { return index_.size(); }

bool MatchingEngine::crosses(Side side, Price price) const {
  if (side == Side::Buy) {
    return !asks_.empty() && price >= asks_.begin()->first;
  }
  return !bids_.empty() && price <= bids_.begin()->first;
}

void MatchingEngine::rest(OrderRequest request, Quantity remaining) {
  Order order{request.id, request.side, request.price, remaining, ++sequence_};
  if (request.side == Side::Buy) {
    bids_[request.price].push_back(order);
  } else {
    asks_[request.price].push_back(order);
  }
  index_[request.id] = OrderLocation{request.side, request.price};
}

bool MatchingEngine::erase_from_level(OrderId id, Level& level) {
  auto it = std::find_if(level.begin(), level.end(),
                         [&](const Order& order) { return order.id == id; });
  if (it == level.end()) {
    return false;
  }
  level.erase(it);
  return true;
}

void MatchingEngine::prune_empty_level(Side side, Price price) {
  if (side == Side::Buy) {
    auto level = bids_.find(price);
    if (level != bids_.end() && level->second.empty()) {
      bids_.erase(level);
    }
    return;
  }

  auto level = asks_.find(price);
  if (level != asks_.end() && level->second.empty()) {
    asks_.erase(level);
  }
}

const char* to_string(Side side) {
  return side == Side::Buy ? "buy" : "sell";
}

const char* to_string(OrderType type) {
  return type == OrderType::Limit ? "limit" : "market";
}

const char* to_string(TimeInForce tif) {
  return tif == TimeInForce::Gtc ? "gtc" : "ioc";
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
  if (value == "limit") {
    return OrderType::Limit;
  }
  if (value == "market") {
    return OrderType::Market;
  }
  throw std::invalid_argument("type must be limit or market");
}

TimeInForce parse_tif(const std::string& value) {
  if (value == "gtc") {
    return TimeInForce::Gtc;
  }
  if (value == "ioc") {
    return TimeInForce::Ioc;
  }
  throw std::invalid_argument("tif must be gtc or ioc");
}

}  // namespace exchange
