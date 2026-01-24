#!/bin/bash

# Vitest process cleanup script
# Check and remove zombie processes after test execution

echo "🔍 Checking for remaining test processes..."

# Vitest process check
VITEST_PROCESSES=$(ps aux | grep vitest | grep -v grep || true)
if [ -n "$VITEST_PROCESSES" ]; then
    echo "⚠️  Found vitest processes:"
    echo "$VITEST_PROCESSES"
    echo "🔥 Killing vitest processes..."
    pkill -f vitest
    echo "✅ Vitest processes cleaned up"
else
    echo "✅ No vitest processes found"
fi

# Node test process check
NODE_TEST_PROCESSES=$(ps aux | grep "node.*test" | grep -v grep || true)
if [ -n "$NODE_TEST_PROCESSES" ]; then
    echo "⚠️  Found node test processes:"
    echo "$NODE_TEST_PROCESSES"
    echo "🔥 Killing node test processes..."
    pkill -f "node.*test"
    echo "✅ Node test processes cleaned up"
else
    echo "✅ No node test processes found"
fi

echo "🧹 Process cleanup completed!"