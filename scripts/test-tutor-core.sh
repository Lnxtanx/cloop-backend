#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# A separate Node process isolates provider and Prisma stubs in every suite.
task_test_dir=$(mktemp -d /tmp/cloop-tests.XXXXXX)
trap 'rm -rf "$task_test_dir"' EXIT
total_tests=0
total_suites=0
for test_file in services/tutor-core/*.test.js services/topic-chat/topic-chat-helpers.test.js services/goal-pipelines.test.js api/topic-chats/topic-chats-v2.test.js; do
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
echo "$total_tests tests passed across $total_suites suites. No live model or database calls."
