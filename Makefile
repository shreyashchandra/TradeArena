CXX ?= g++
CXXFLAGS ?= -std=c++20 -O3 -DNDEBUG -Wall -Wextra -Wpedantic -Iengine/include
DEBUGFLAGS ?= -std=c++20 -O0 -g -Wall -Wextra -Wpedantic -Iengine/include

BUILD_DIR := build
ENGINE_SRC := engine/src/matching_engine.cpp
PAPER_SRC := engine/src/paper_trading.cpp
SERVER_SRC := engine/src/server.cpp
TEST_SRC := engine/tests/matching_engine_tests.cpp
PAPER_TEST_SRC := engine/tests/paper_trading_tests.cpp

.PHONY: all server test clean debug

all: server test

server: $(BUILD_DIR)/exchange_server

debug:
	$(CXX) $(DEBUGFLAGS) $(ENGINE_SRC) $(SERVER_SRC) -o $(BUILD_DIR)/exchange_server_debug

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BUILD_DIR)/exchange_server: $(PAPER_SRC) $(SERVER_SRC) | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) $(PAPER_SRC) $(SERVER_SRC) -o $@

$(BUILD_DIR)/matching_engine_tests: $(ENGINE_SRC) $(TEST_SRC) | $(BUILD_DIR)
	$(CXX) $(DEBUGFLAGS) $(ENGINE_SRC) $(TEST_SRC) -o $@

$(BUILD_DIR)/paper_trading_tests: $(PAPER_SRC) $(PAPER_TEST_SRC) | $(BUILD_DIR)
	$(CXX) $(DEBUGFLAGS) $(PAPER_SRC) $(PAPER_TEST_SRC) -o $@

test: $(BUILD_DIR)/matching_engine_tests $(BUILD_DIR)/paper_trading_tests
	./$(BUILD_DIR)/matching_engine_tests
	PAPER_DISABLE_LIVE_DATA=1 ./$(BUILD_DIR)/paper_trading_tests

clean:
	rm -rf $(BUILD_DIR)
