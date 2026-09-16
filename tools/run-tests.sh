#!/bin/bash
# run-tests [ref] — test a commit (HEAD by default), never its working tree.
# Discover every test suite and type-check every workspace from a clean extraction.
# Workspaces and suites are discovered independently: a hardcoded workspace
# list once silently skipped a new package, and treating package.json as the
# only test root later skipped tools/test because tools is not a workspace.
# Dependencies are staged for ALL workspaces before ANY test runs, because a
# workspace tested before its dependency's node_modules exist fails for the
# wrong reason.
if [ "${NODE_OPTIONS+x}" = x ]; then
  printf 'run-tests: refusing altered Node environment: NODE_OPTIONS is set to %q\n' "$NODE_OPTIONS" >&2
  echo "run-tests: unset NODE_OPTIONS; loader, import, require, and other Node hooks are not admitted" >&2
  exit 2
fi
set -u
repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$repository_root"
branch=${1:-HEAD}
# A nonexistent ref must abort before an extraction or verdict.
git rev-parse --verify -q "$branch^{commit}" >/dev/null || {
  echo "run-tests: no such ref: $branch" >&2
  exit 2
}
echo "=== clean extraction of $branch tip ==="
# Keep the large extraction and copied dependencies on the repository's
# disk-backed filesystem. On systems with tmpfs-backed /tmp, retaining one
# fixed extraction there can consume gigabytes of RAM.
test_scratch_parent="$repository_root/.git/run-tests"
mkdir -p "$test_scratch_parent" || {
  echo "run-tests.environment.scratch-unavailable: cannot create $test_scratch_parent" >&2
  exit 2
}
# Failure output must outlive the disposable extraction so a transient failure
# remains diagnosable after the cleanup trap runs. Clear the fixed location
# before each run so output from an earlier ref can never be mistaken for
# this run's evidence.
test_failure_logs="$test_scratch_parent/failures"
if ! rm -rf -- "$test_failure_logs" || ! mkdir -p "$test_failure_logs"; then
  echo "run-tests.environment.failure-log-unavailable: cannot initialize $test_failure_logs" >&2
  exit 2
fi
test_run=$(mktemp -d "$test_scratch_parent/run.XXXXXX") || {
  echo "run-tests.environment.scratch-unavailable: cannot allocate disk-backed test scratch" >&2
  exit 2
}
cleanup_test_run() {
  rm -rf -- "$test_run"
}
trap cleanup_test_run EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
test_extraction="$test_run/extraction"
test_tmp="$test_run/tmp"
mkdir -p "$test_extraction" "$test_tmp" || {
  echo "run-tests.environment.scratch-unavailable: cannot initialize $test_run" >&2
  exit 2
}
export TMPDIR="$test_tmp"
# Unlike the disposable extraction and rotating failure transcript, Chrome's
# per-failure evidence must survive this run and subsequent runs. The
# shared Chrome launch is always armed; this only selects disk-backed storage.
export PDR_CHROME_EVIDENCE_DIR="$test_scratch_parent/chrome-evidence"
git archive "$branch" | tar -x -C "$test_extraction"
cd "$test_extraction"
workspaces=$(find . -name package.json -not -path '*/node_modules/*' -printf '%h\n' | sed 's|^\./||' | sort)
test_roots=$(find . -type f -path '*/test/*.test.mjs' -not -path '*/node_modules/*' -print \
  | sed -e 's|^\./||' -e 's|/test/.*$||' | sort -u)
echo "workspaces discovered: $(echo "$workspaces" | tr '\n' ' ')"
echo "test suites discovered: $(echo "$test_roots" | tr '\n' ' ')"
missing_dependencies=()
for w in $workspaces; do
  [ -d "$repository_root/$w/node_modules" ] || missing_dependencies+=("$w")
done
if [ "${#missing_dependencies[@]}" -ne 0 ]; then
  printf 'run-tests.environment.dependencies-missing: no node_modules for %s\n' "${missing_dependencies[*]}" >&2
  echo 'run-tests: run node tools/install-package-build-dependencies.mjs once, then rerun bash tools/run-tests.sh' >&2
  exit 2
fi
for w in $workspaces; do
  if ! cp -r "$repository_root/$w/node_modules" "$w/node_modules"; then
    echo "run-tests.environment.dependency-staging-failed: could not stage $w/node_modules in disk-backed scratch" >&2
    exit 2
  fi
done
echo
fail=0; tested=0
suite_timeout_seconds=30
for w in $test_roots; do
  printf '%-32s ' "$w"
  raw=$( cd "$w" && timeout --foreground --kill-after=5s \
    "${suite_timeout_seconds}s" node --test test/*.test.mjs 2>&1 )
  status=$?
  p=$(printf '%s' "$raw" | grep -oE '^. pass [0-9]+' | grep -oE '[0-9]+' | head -1)
  f=$(printf '%s' "$raw" | grep -oE '^. fail [0-9]+' | grep -oE '[0-9]+' | head -1)
  echo "pass=${p:-?} fail=${f:-?}"
  tested=$((tested+1))
  if [ "$status" -ne 0 ] || [ "${f:-1}" != "0" ] || [ -z "$p" ]; then
    fail=1
    [ "$status" -eq 124 ] && echo "  suite exceeded ${suite_timeout_seconds}s wall-clock bound"
    suite_log_name=${w//\//__}
    failure_log=$(printf '%s/%03d-%s.log' "$test_failure_logs" "$tested" "$suite_log_name")
    if ! printf '%s\n' "$raw" > "$failure_log"; then
      echo "run-tests.environment.failure-log-unavailable: cannot retain output for $w at $failure_log" >&2
      exit 2
    fi
    echo "  complete failure output: $failure_log"
    # A TAP failure block carries the test name followed by its assertion
    # diagnostics. If the process died without producing one, its tail is the
    # most useful inline account; the complete output remains in the log.
    if printf '%s\n' "$raw" | grep -qE '^[[:space:]]*not ok '; then
      printf '%s\n' "$raw" | awk '
        /^[[:space:]]*not ok / { if (!printing) printing=1 }
        printing { print "  " $0; lines++ }
        lines == 80 { exit }
      '
    else
      printf '%s\n' "$raw" | tail -80 | sed 's/^/  /'
    fi
  fi
done
# Run each workspace's OWN check script rather than a tsc invocation chosen
# here. Those are not the same thing: packages/contracts declares
# `tsc --noEmit && tsc -p tsconfig.test.json`, and this script used to run only
# the first half, so every line of test TypeScript went unchecked by the
# test run while the workspace loop checked it. A compile-time negative
# control in packages/contracts/test was therefore green here no matter what it
# was pointed at. Silently checking less than a workspace declares is a false
# pass.
for w in $workspaces; do
  if [ -f "$w/package.json" ] && node -e "process.exit((require('./$w/package.json').scripts||{}).check?0:1)" 2>/dev/null; then
    ( cd "$w" && npm run --silent check ) || { echo "  CHECK FAILED in $w"; fail=1; }
  elif [ -f "$w/tsconfig.json" ]; then
    echo "  note: $w has a tsconfig but declares no check script; running tsc directly"
    ( cd "$w" && npx --no-install tsc --noEmit ) || { echo "  TSC FAILED in $w"; fail=1; }
  fi
done

echo
echo "test suites run: $tested"
# Zero suites tested is a broken extraction, not a passing branch.
[ "$tested" -gt 0 ] || { echo "run-tests: no test suites ran; refusing to render a verdict" >&2; exit 2; }
echo "VERDICT: $( [ $fail -eq 0 ] && echo "$branch passes from a clean extraction" || echo "$branch fails from a clean extraction" )"
exit $fail
