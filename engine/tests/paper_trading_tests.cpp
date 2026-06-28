#include "paper_trading.hpp"

#include <cassert>
#include <iostream>

using namespace paper;

int main() {
  PaperTradingEngine engine;

  auto buy = engine.submit(
      {1, "RELIANCE", Side::Buy, OrderType::Market, 0, 10});
  assert(buy.accepted);
  assert(buy.fills.size() == 1);

  auto state = engine.state();
  assert(state.positions.size() == 1);
  assert(state.positions[0].quantity == 10);
  assert(state.account.cash < 100000000);

  auto limit = engine.submit(
      {2, "RELIANCE", Side::Buy, OrderType::Limit, 1, 10});
  assert(limit.accepted);
  assert(limit.order.status == "open");
  assert(engine.cancel(2));

  auto sell = engine.submit(
      {3, "RELIANCE", Side::Sell, OrderType::Market, 0, 4});
  assert(sell.accepted);
  state = engine.state();
  assert(state.positions[0].quantity == 6);

  std::cout << "paper trading tests passed\n";
  return 0;
}
