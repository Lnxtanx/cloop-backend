#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Run each suite in its own process to isolate provider/Prisma stubs. This gate
# exercises both tutor routes; it does not bind a port or require API keys.
task_test_dir=$(mktemp -d /tmp/cloop-final-ncert-runtime.XXXXXX)
trap 'rm -rf "$task_test_dir"' EXIT
total_tests=0
total_suites=0
for test_file in services/tutor-core/*.test.js \
  services/academic-graph/*.test.js \
  ai/agents/socratic-tutor/context/context-builder.test.js \
  ai/agents/socratic-tutor/prompts/prompts.test.js \
  ai/agents/socratic-tutor/socratic-tutor.test.js \
  api/topic-chats/*.test.js; do
  task_test_output="$task_test_dir/output.log"
  if ! node --test-reporter=tap "$test_file" > "$task_test_output" 2>&1; then
    cat "$task_test_output"
    exit 1
  fi
  test_count=$(sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' "$task_test_output")
  if [[ -z "$test_count" || "$test_count" == 0 ]]; then
    cat "$task_test_output"
    exit 1
  fi
  total_tests=$((total_tests + test_count))
  total_suites=$((total_suites + 1))
  echo "$test_file: $test_count passed"
done
echo "$total_tests tests passed across $total_suites isolated suites. No live model or database calls."
