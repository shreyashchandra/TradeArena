#include "paper_trading.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cctype>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

using namespace paper;

namespace {

std::atomic_bool running{true};

struct HttpRequest {
  std::string method;
  std::string path;
  std::string body;
  std::unordered_map<std::string, std::string> headers;
};

std::string json_escape(const std::string& value) {
  std::string out;
  for (char ch : value) {
    if (ch == '"') {
      out += "\\\"";
    } else if (ch == '\\') {
      out += "\\\\";
    } else {
      out += ch;
    }
  }
  return out;
}

std::string read_file(const std::string& path) {
  std::ifstream file(path);
  if (!file) {
    return "";
  }
  std::ostringstream out;
  out << file.rdbuf();
  return out.str();
}

std::string swagger_html() {
  return R"(<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TradeArena API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.onload = () => {
        window.ui = SwaggerUIBundle({
          url: "/openapi.json",
          dom_id: "#swagger-ui"
        });
      };
    </script>
  </body>
</html>)";
}

std::string get_string(const std::string& json, const std::string& key,
                       const std::string& fallback = "") {
  const std::string needle = "\"" + key + "\"";
  const auto key_pos = json.find(needle);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  const auto colon = json.find(':', key_pos + needle.size());
  const auto first = json.find('"', colon);
  const auto second = json.find('"', first + 1);
  if (colon == std::string::npos || first == std::string::npos ||
      second == std::string::npos) {
    return fallback;
  }
  return json.substr(first + 1, second - first - 1);
}

std::uint64_t get_u64(const std::string& json, const std::string& key,
                      std::uint64_t fallback = 0) {
  const std::string needle = "\"" + key + "\"";
  const auto key_pos = json.find(needle);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  const auto colon = json.find(':', key_pos + needle.size());
  if (colon == std::string::npos) {
    return fallback;
  }
  const auto begin = json.find_first_of("0123456789", colon + 1);
  if (begin == std::string::npos) {
    return fallback;
  }
  const auto end = json.find_first_not_of("0123456789", begin);
  return std::stoull(json.substr(begin, end - begin));
}

std::string url_decode(const std::string& value) {
  std::string out;
  for (std::size_t i = 0; i < value.size(); ++i) {
    if (value[i] == '+') {
      out += ' ';
    } else if (value[i] == '%' && i + 2 < value.size()) {
      const auto hex = value.substr(i + 1, 2);
      out += static_cast<char>(std::strtol(hex.c_str(), nullptr, 16));
      i += 2;
    } else {
      out += value[i];
    }
  }
  return out;
}

std::string query_param(const std::string& path, const std::string& key) {
  const auto question = path.find('?');
  if (question == std::string::npos) {
    return "";
  }
  const std::string needle = key + "=";
  auto pos = path.find(needle, question + 1);
  if (pos == std::string::npos) {
    return "";
  }
  pos += needle.size();
  const auto end = path.find('&', pos);
  return url_decode(path.substr(pos, end - pos));
}

std::size_t content_length(const std::string& raw) {
  auto pos = raw.find("Content-Length:");
  if (pos == std::string::npos) {
    pos = raw.find("content-length:");
  }
  if (pos == std::string::npos) {
    return 0;
  }
  const auto begin = raw.find_first_of("0123456789", pos);
  const auto end = raw.find_first_not_of("0123456789", begin);
  return std::stoul(raw.substr(begin, end - begin));
}

HttpRequest parse_request(const std::string& raw) {
  HttpRequest request;
  const auto line_end = raw.find("\r\n");
  std::istringstream first(raw.substr(0, line_end));
  first >> request.method >> request.path;

  std::size_t cursor = line_end == std::string::npos ? 0 : line_end + 2;
  while (cursor < raw.size()) {
    const auto next = raw.find("\r\n", cursor);
    if (next == std::string::npos || next == cursor) {
      break;
    }
    const auto line = raw.substr(cursor, next - cursor);
    const auto colon = line.find(':');
    if (colon != std::string::npos) {
      auto key = line.substr(0, colon);
      std::transform(key.begin(), key.end(), key.begin(),
                     [](unsigned char ch) { return std::tolower(ch); });
      auto value = line.substr(colon + 1);
      while (!value.empty() && value.front() == ' ') {
        value.erase(value.begin());
      }
      request.headers[key] = value;
    }
    cursor = next + 2;
  }

  const auto body_start = raw.find("\r\n\r\n");
  if (body_start != std::string::npos) {
    request.body = raw.substr(body_start + 4);
  }
  return request;
}

OrderRequest parse_order(const std::string& body) {
  return OrderRequest{
      get_u64(body, "id"),
      get_string(body, "symbol", "RELIANCE"),
      parse_side(get_string(body, "side", "buy")),
      parse_order_type(get_string(body, "type", "market")),
      static_cast<Price>(get_u64(body, "price")),
      get_u64(body, "quantity"),
  };
}

std::string fill_json(const Fill& fill) {
  std::ostringstream out;
  out << "{\"orderId\":" << fill.order_id << ",\"symbol\":\""
      << json_escape(fill.symbol) << "\",\"side\":\"" << to_string(fill.side)
      << "\",\"price\":" << fill.price << ",\"quantity\":" << fill.quantity
      << "}";
  return out.str();
}

std::string order_json(const Order& order) {
  std::ostringstream out;
  out << "{\"id\":" << order.id << ",\"symbol\":\"" << json_escape(order.symbol)
      << "\",\"side\":\"" << to_string(order.side) << "\",\"type\":\""
      << to_string(order.type) << "\",\"price\":" << order.price
      << ",\"quantity\":" << order.quantity << ",\"remaining\":"
      << order.remaining << ",\"status\":\"" << json_escape(order.status)
      << "\"}";
  return out.str();
}

std::string ack_json(const OrderAck& ack) {
  std::ostringstream out;
  out << "{\"accepted\":" << (ack.accepted ? "true" : "false")
      << ",\"message\":\"" << json_escape(ack.message) << "\",\"order\":"
      << order_json(ack.order) << ",\"fills\":[";
  for (std::size_t i = 0; i < ack.fills.size(); ++i) {
    if (i != 0) {
      out << ',';
    }
    out << fill_json(ack.fills[i]);
  }
  out << "]}";
  return out.str();
}

std::string quote_json(const Quote& quote) {
  std::ostringstream out;
  out << "{\"symbol\":\"" << json_escape(quote.symbol) << "\",\"bid\":"
      << quote.bid << ",\"ask\":" << quote.ask << ",\"last\":"
      << quote.last << ",\"changeBps\":" << quote.change_bps << "}";
  return out.str();
}

std::string search_results_json(const std::vector<SymbolSearchResult>& results) {
  std::ostringstream out;
  out << "{\"results\":[";
  for (std::size_t i = 0; i < results.size(); ++i) {
    if (i != 0) {
      out << ',';
    }
    out << "{\"symbol\":\"" << json_escape(results[i].symbol)
        << "\",\"yahooSymbol\":\"" << json_escape(results[i].yahoo_symbol)
        << "\",\"name\":\"" << json_escape(results[i].name)
        << "\",\"exchange\":\"" << json_escape(results[i].exchange) << "\"}";
  }
  out << "]}";
  return out.str();
}

std::string state_json(const State& state) {
  std::ostringstream out;
  out << "{\"account\":{\"cash\":" << state.account.cash
      << ",\"equity\":" << state.account.equity
      << ",\"realizedPnl\":" << state.account.realized_pnl
      << ",\"unrealizedPnl\":" << state.account.unrealized_pnl
      << "},\"quotes\":[";
  for (std::size_t i = 0; i < state.quotes.size(); ++i) {
    const auto& quote = state.quotes[i];
    if (i != 0) {
      out << ',';
    }
    out << quote_json(quote);
  }
  out << "],\"positions\":[";
  for (std::size_t i = 0; i < state.positions.size(); ++i) {
    const auto& pos = state.positions[i];
    if (i != 0) {
      out << ',';
    }
    out << "{\"symbol\":\"" << json_escape(pos.symbol) << "\",\"quantity\":"
        << pos.quantity << ",\"averagePrice\":" << pos.average_price
        << ",\"markPrice\":" << pos.mark_price << ",\"unrealizedPnl\":"
        << pos.unrealized_pnl << "}";
  }
  out << "],\"openOrders\":[";
  for (std::size_t i = 0; i < state.open_orders.size(); ++i) {
    if (i != 0) {
      out << ',';
    }
    out << order_json(state.open_orders[i]);
  }
  out << "],\"fills\":[";
  for (std::size_t i = 0; i < state.fills.size(); ++i) {
    if (i != 0) {
      out << ',';
    }
    out << fill_json(state.fills[i]);
  }
  out << "]}";
  return out.str();
}

class Server {
 public:
  explicit Server(int port) : port_(port) {}

  void run() {
    fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd_ < 0) {
      throw std::runtime_error("socket failed");
    }

    int yes = 1;
    ::setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons(static_cast<uint16_t>(port_));

    if (::bind(fd_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) <
        0) {
      throw std::runtime_error(std::string("bind failed: ") +
                               std::strerror(errno));
    }
    if (::listen(fd_, 64) < 0) {
      throw std::runtime_error(std::string("listen failed: ") +
                               std::strerror(errno));
    }

    std::thread(&Server::market_loop, this).detach();
    std::cout << "tradearena api listening on http://localhost:" << port_
              << "\n";

    while (running) {
      const int client = ::accept(fd_, nullptr, nullptr);
      if (client >= 0) {
        std::thread(&Server::handle, this, client).detach();
      }
    }
  }

 private:
  struct SseClient {
    int fd{};
    std::string user;
  };

  int port_{8081};
  int fd_{-1};
  std::mutex engine_mutex_;
  std::mutex clients_mutex_;
  std::unordered_map<std::string, PaperTradingEngine> engines_;
  std::vector<SseClient> sse_clients_;

  PaperTradingEngine& engine_for(const std::string& user) {
    const auto key = user.empty() ? "anonymous" : user;
    auto [it, _] = engines_.try_emplace(key);
    return it->second;
  }

  static std::string user_for(const HttpRequest& request) {
    const auto found = request.headers.find("x-tradearena-user");
    if (found == request.headers.end() || found->second.empty()) {
      return "anonymous";
    }
    return found->second;
  }

  static void write_all(int fd, const std::string& data) {
    const char* cursor = data.data();
    std::size_t left = data.size();
    while (left > 0) {
      const auto written = ::send(fd, cursor, left, 0);
      if (written <= 0) {
        return;
      }
      cursor += written;
      left -= static_cast<std::size_t>(written);
    }
  }

  static std::string header(int status, const std::string& type,
                            std::size_t length) {
    const char* reason = status == 200   ? "OK"
                         : status == 201 ? "Created"
                         : status == 204 ? "No Content"
                         : status == 400 ? "Bad Request"
                         : status == 404 ? "Not Found"
                                         : "Internal Server Error";
    std::ostringstream out;
    out << "HTTP/1.1 " << status << ' ' << reason << "\r\n"
        << "Access-Control-Allow-Origin: *\r\n"
        << "Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS\r\n"
        << "Access-Control-Allow-Headers: Content-Type,Authorization,X-TradeArena-User\r\n"
        << "Connection: close\r\n"
        << "Content-Type: " << type << "\r\n"
        << "Content-Length: " << length << "\r\n\r\n";
    return out.str();
  }

  void respond(int client, int status, const std::string& body) {
    write_all(client, header(status, "application/json", body.size()) + body);
  }

  void respond_with_type(int client, int status, const std::string& type,
                         const std::string& body) {
    write_all(client, header(status, type, body.size()) + body);
  }

  void handle(int client) {
    std::string raw;
    char buffer[4096];
    auto bytes = ::recv(client, buffer, sizeof(buffer), 0);
    if (bytes <= 0) {
      ::close(client);
      return;
    }
    raw.append(buffer, static_cast<std::size_t>(bytes));
    const auto headers_end = raw.find("\r\n\r\n");
    const auto length = content_length(raw);
    while (headers_end != std::string::npos &&
           raw.size() < headers_end + 4 + length) {
      bytes = ::recv(client, buffer, sizeof(buffer), 0);
      if (bytes <= 0) {
        break;
      }
      raw.append(buffer, static_cast<std::size_t>(bytes));
    }

    const auto request = parse_request(raw);
    if (request.method == "OPTIONS") {
      respond(client, 204, "");
      ::close(client);
      return;
    }
    if (request.method == "GET" && request.path == "/api/events") {
      subscribe(client, user_for(request));
      return;
    }

    try {
      route(client, request);
    } catch (const std::exception& error) {
      respond(client, 400,
              "{\"error\":\"" + json_escape(error.what()) + "\"}");
    }
    ::close(client);
  }

  void route(int client, const HttpRequest& request) {
    if ((request.method == "GET" || request.method == "HEAD") &&
        request.path == "/health") {
      respond(client, 200, "{\"status\":\"ok\",\"service\":\"tradearena-backend\"}");
      return;
    }

    if ((request.method == "GET" || request.method == "HEAD") &&
        (request.path == "/" || request.path.empty())) {
      respond(client, 200,
              "{\"service\":\"tradearena-backend\",\"docs\":\"/docs\",\"health\":\"/health\"}");
      return;
    }

    if ((request.method == "GET" || request.method == "HEAD") &&
        request.path == "/openapi.json") {
      const auto spec = read_file("docs/openapi.json");
      if (spec.empty()) {
        respond(client, 404, "{\"error\":\"openapi spec not found\"}");
      } else {
        respond_with_type(client, 200, "application/json", spec);
      }
      return;
    }

    if ((request.method == "GET" || request.method == "HEAD") &&
        (request.path == "/docs" || request.path == "/docs/")) {
      respond_with_type(client, 200, "text/html; charset=utf-8", swagger_html());
      return;
    }

    if (request.method == "GET" && request.path == "/api/state") {
      State state;
      {
        std::lock_guard lock(engine_mutex_);
        state = engine_for(user_for(request)).state();
      }
      respond(client, 200, state_json(state));
      return;
    }

    if (request.method == "GET" &&
        request.path.rfind("/api/search", 0) == 0) {
      std::vector<SymbolSearchResult> results;
      {
        std::lock_guard lock(engine_mutex_);
        results = engine_for(user_for(request)).search_symbols(
            query_param(request.path, "q"));
      }
      respond(client, 200, search_results_json(results));
      return;
    }

    if (request.method == "POST" && request.path == "/api/symbols") {
      std::optional<Quote> quote;
      State state;
      {
        std::lock_guard lock(engine_mutex_);
        auto& engine = engine_for(user_for(request));
        quote = engine.add_symbol(get_string(request.body, "yahooSymbol"));
        state = engine.state();
      }
      if (!quote) {
        respond(client, 404, "{\"error\":\"symbol not found\"}");
        return;
      }
      broadcast("state", state_json(state), user_for(request));
      respond(client, 201, "{\"quote\":" + quote_json(*quote) + "}");
      return;
    }

    if (request.method == "POST" && request.path == "/api/orders") {
      OrderAck ack;
      State state;
      {
        std::lock_guard lock(engine_mutex_);
        auto& engine = engine_for(user_for(request));
        ack = engine.submit(parse_order(request.body));
        state = engine.state();
      }
      broadcast("state", state_json(state), user_for(request));
      for (const auto& fill : ack.fills) {
        broadcast("fill", fill_json(fill), user_for(request));
      }
      respond(client, ack.accepted ? 201 : 400, ack_json(ack));
      return;
    }

    if (request.method == "DELETE" &&
        request.path.rfind("/api/orders/", 0) == 0) {
      const auto id =
          std::stoull(request.path.substr(std::strlen("/api/orders/")));
      bool removed = false;
      State state;
      {
        std::lock_guard lock(engine_mutex_);
        auto& engine = engine_for(user_for(request));
        removed = engine.cancel(id);
        state = engine.state();
      }
      broadcast("state", state_json(state), user_for(request));
      respond(client, removed ? 200 : 404,
              removed ? "{\"cancelled\":true}" : "{\"cancelled\":false}");
      return;
    }

    if (request.method == "POST" && request.path == "/api/reset") {
      State state;
      {
        std::lock_guard lock(engine_mutex_);
        auto& engine = engine_for(user_for(request));
        engine.reset();
        state = engine.state();
      }
      broadcast("state", state_json(state), user_for(request));
      respond(client, 200, "{\"reset\":true}");
      return;
    }

    respond(client, 404, "{\"error\":\"not found\"}");
  }

  void subscribe(int client, const std::string& user) {
    write_all(client,
              "HTTP/1.1 200 OK\r\n"
              "Access-Control-Allow-Origin: *\r\n"
              "Content-Type: text/event-stream\r\n"
              "Cache-Control: no-cache\r\n"
              "Connection: keep-alive\r\n\r\n");
    {
      std::lock_guard lock(clients_mutex_);
      sse_clients_.push_back(SseClient{client, user});
    }
    State state;
    {
      std::lock_guard lock(engine_mutex_);
      state = engine_for(user).state();
    }
    write_event(client, "state", state_json(state));
  }

  void market_loop() {
    while (running) {
      std::this_thread::sleep_for(std::chrono::milliseconds(850));
      std::vector<std::pair<std::string, State>> states;
      std::vector<std::pair<std::string, std::vector<Fill>>> fills_by_user;
      {
        std::lock_guard lock(engine_mutex_);
        for (auto& [user, engine] : engines_) {
          auto fills = engine.tick();
          states.push_back({user, engine.state()});
          if (!fills.empty()) {
            fills_by_user.push_back({user, fills});
          }
        }
      }
      for (const auto& [user, state] : states) {
        broadcast("state", state_json(state), user);
      }
      for (const auto& [user, fills] : fills_by_user) {
        for (const auto& fill : fills) {
          broadcast("fill", fill_json(fill), user);
        }
      }
    }
  }

  void broadcast(const std::string& event, const std::string& data,
                 const std::string& user) {
    std::lock_guard lock(clients_mutex_);
    auto it = sse_clients_.begin();
    while (it != sse_clients_.end()) {
      if (it->user != user) {
        ++it;
        continue;
      }
      if (write_event(it->fd, event, data)) {
        ++it;
      } else {
        ::close(it->fd);
        it = sse_clients_.erase(it);
      }
    }
  }

  static bool write_event(int client, const std::string& event,
                          const std::string& data) {
    const auto payload = "event: " + event + "\ndata: " + data + "\n\n";
    const auto sent = ::send(client, payload.data(), payload.size(), 0);
    return sent == static_cast<ssize_t>(payload.size());
  }
};

void stop(int) { running = false; }

}  // namespace

int main(int argc, char** argv) {
  std::signal(SIGPIPE, SIG_IGN);
  std::signal(SIGINT, stop);
  std::signal(SIGTERM, stop);

  const int port = argc > 1 ? std::atoi(argv[1]) : 8081;
  try {
    Server server(port);
    server.run();
  } catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
  return 0;
}
