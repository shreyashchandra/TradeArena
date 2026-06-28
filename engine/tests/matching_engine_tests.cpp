#include "matching_engine.hpp"

#include <cassert>
#include <iostream>

using namespace exchange;

namespace {

void price_time_priority() {
  MatchingEngine engine;

  auto a = engine.submit({1, Side::Sell, OrderType::Limit, 10100, 5});
  auto b = engine.submit({2, Side::Sell, OrderType::Limit, 10100, 7});
  auto c = engine.submit({3, Side::Buy, OrderType::Limit, 10100, 9});

  assert(a.accepted && a.resting);
  assert(b.accepted && b.resting);
  assert(c.accepted);
  assert(c.trades.size() == 2);
  assert(c.trades[0].maker_id == 1);
  assert(c.trades[0].quantity == 5);
  assert(c.trades[1].maker_id == 2);
  assert(c.trades[1].quantity == 4);

  auto remaining = engine.find(2);
  assert(remaining);
  assert(remaining->quantity == 3);
}

void best_price_priority() {
  MatchingEngine engine;
  engine.submit({1, Side::Sell, OrderType::Limit, 10200, 5});
  engine.submit({2, Side::Sell, OrderType::Limit, 10100, 5});

  auto ack = engine.submit({3, Side::Buy, OrderType::Limit, 10200, 4});
  assert(ack.trades.size() == 1);
  assert(ack.trades[0].maker_id == 2);
  assert(ack.trades[0].price == 10100);
}

void market_and_ioc_do_not_rest() {
  MatchingEngine engine;
  auto market = engine.submit({1, Side::Buy, OrderType::Market, 0, 10});
  assert(market.accepted);
  assert(!market.resting);
  assert(engine.open_order_count() == 0);

  auto ioc = engine.submit({2, Side::Sell, OrderType::Limit, 9900, 10,
                            TimeInForce::Ioc});
  assert(ioc.accepted);
  assert(!ioc.resting);
  assert(engine.open_order_count() == 0);
}

void cancel_order() {
  MatchingEngine engine;
  engine.submit({1, Side::Buy, OrderType::Limit, 10000, 5});
  assert(engine.cancel(1));
  assert(!engine.cancel(1));
  assert(engine.open_order_count() == 0);
}

}  // namespace

int main() {
  price_time_priority();
  best_price_priority();
  market_and_ioc_do_not_rest();
  cancel_order();

  std::cout << "matching engine tests passed\n";
  return 0;
}
