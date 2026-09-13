import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const runTests = new URL("../run-tests.sh", import.meta.url).pathname;
const missingBranch = "review-environment-control-missing-branch";

for (const nodeOptions of [
  "--experimental-loader=/tmp/review-loader.mjs",
  "--import=/tmp/review-import.mjs",
]) {
  test(`run-tests refuses Node hook ${nodeOptions.split("=")[0]}`, async () => {
    await assert.rejects(
      execute(runTests, [missingBranch], {
        env: { ...process.env, NODE_OPTIONS: nodeOptions },
      }),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /refusing altered Node environment/u);
        assert.match(error.stderr, new RegExp(nodeOptions.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        return true;
      },
    );
  });
}

test("run-tests reaches ref validation when NODE_OPTIONS is absent", async () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  await assert.rejects(
    execute(runTests, [missingBranch], { env }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /no such ref/u);
      assert.doesNotMatch(error.stderr, /altered Node environment/u);
      return true;
    },
  );
});

test("run-tests defaults to HEAD from its own repository, independent of HOME", async t => {
  const fixture = await reviewFixture(t);
  const result = await execute(fixture.script, [], { env: fixture.env, cwd: fixture.ambientTmp });
  assert.match(result.stdout, /VERDICT: HEAD passes from a clean extraction/u);
});

test("run-tests replaces ambient TMPDIR with its disk-backed run scratch", async (t) => {
  const fixture = await reviewFixture(t);
  const result = await execute(fixture.script, [fixture.branch], { env: fixture.env });

  assert.match(result.stdout, /VERDICT: candidate passes from a clean extraction/u);
  const observed = (await fixture.readTmpdirLog()).trim().split("\n");
  assert.ok(observed.length > 0);
  for (const directory of observed) {
    assert.notEqual(directory, fixture.ambientTmp);
    assert.match(
      directory,
      new RegExp(`^${escapeRegExp(join(fixture.repository, ".git", "run-tests", "run."))}[^/]+/tmp$`, "u"),
    );
  }
});

test("run-tests refuses a dependency-staging environment failure before verdict", async (t) => {
  const fixture = await reviewFixture(t, { failingCopy: true });
  await assert.rejects(
    execute(fixture.script, [fixture.branch], { env: fixture.env }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /run-tests\.environment\.dependency-staging-failed/u);
      assert.doesNotMatch(error.stdout, /VERDICT:/u);
      return true;
    },
  );
});

test("run-tests keeps Chrome evidence outside extraction and does not rotate it on the next review", async t => {
  const fixture = await reviewFixture(t);
  const env = { ...fixture.env, REVIEW_CAPTURE_EVIDENCE: "1", PDR_CHROME_EVIDENCE_DIR: fixture.ambientTmp };
  await execute(fixture.script, [fixture.branch], { env });
  const expected = join(fixture.repository, ".git/run-tests/chrome-evidence");
  const paths = (await fixture.readEvidenceLog()).trim().split("\n");
  assert.ok(paths.length > 0);
  assert.ok(paths.every(path => path === expected));
  const retained = join(expected, "navigation-controlled", "evidence.txt");
  assert.equal(await readFile(retained, "utf8"), "retained before extraction cleanup\n");
  await execute(fixture.script, [fixture.branch], { env });
  assert.equal(await readFile(retained, "utf8"), "retained before extraction cleanup\n");
});

test("run-tests clears retained failure output before a green run", async (t) => {
  const fixture = await reviewFixture(t);
  const staleLog = join(fixture.failureLogs, "stale-branch.log");
  await mkdir(fixture.failureLogs, { recursive: true });
  await writeFile(staleLog, "not this run\n");

  const result = await execute(fixture.script, [fixture.branch], { env: fixture.env });

  assert.equal(result.stderr, "");
  assert.match(result.stdout, /VERDICT: candidate passes from a clean extraction/u);
  await assert.rejects(readFile(staleLog, "utf8"), { code: "ENOENT" });
});

test("run-tests retains and names a failed suite without changing its broken verdict", async (t) => {
  const fixture = await reviewFixture(t, { failingSuite: true });
  let reviewError;
  await assert.rejects(
    execute(fixture.script, [fixture.branch], { env: fixture.env }),
    (error) => {
      reviewError = error;
      assert.equal(error.code, 1);
      assert.match(error.stdout, /not ok 1 - deliberate named review failure/u);
      assert.match(error.stdout, /AssertionError \[ERR_ASSERTION\]/u);
      assert.match(error.stdout, /actual-value/u);
      assert.match(error.stdout, /expected-value/u);
      assert.match(error.stdout, /VERDICT: candidate fails from a clean extraction/u);
      return true;
    },
  );

  const logMatch = reviewError.stdout.match(/complete failure output: (.+\.log)$/mu);
  assert.ok(logMatch, "review output prints the retained failure log path");
  assert.match(logMatch[1], new RegExp(`^${escapeRegExp(fixture.failureLogs)}/`, "u"));
  assert.equal(
    await readFile(logMatch[1], "utf8"),
    `${failingSuiteOutput}\n`,
    "the retained log contains the suite's complete captured output",
  );
});

test("run-tests refuses a verdict when failed-suite output cannot be retained", async (t) => {
  const fixture = await reviewFixture(t, { failingLogWrite: true, failingSuite: true });
  await assert.rejects(
    execute(fixture.script, [fixture.branch], { env: fixture.env }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /run-tests\.environment\.failure-log-unavailable/u);
      assert.doesNotMatch(error.stdout, /VERDICT:/u);
      return true;
    },
  );
});

const failingSuiteOutput = `TAP version 13
not ok 1 - deliberate named review failure
  ---
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    + 'actual-value'
    - 'expected-value'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  stack: |-
    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  ...
x pass 0
x fail 1`;

async function reviewFixture(t, { failingCopy = false, failingLogWrite = false, failingSuite = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "run-tests-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const repository = join(root, "repository");
  const script = join(repository, "tools", "run-tests.sh");
  const fakeBin = join(root, "bin");
  const ambientTmp = join(root, "ambient-tmp");
  const tmpdirLog = join(root, "observed-tmpdir.txt");
  const evidenceLog = join(root, "observed-chrome-evidence.txt");
  await Promise.all([
    mkdir(join(repository, "sample", "test"), { recursive: true }),
    mkdir(join(repository, "packages", "contracts"), { recursive: true }),
    mkdir(join(repository, "devices"), { recursive: true }),
    mkdir(join(repository, "tools"), { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
    mkdir(ambientTmp, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(runTests, script),
    writeFile(join(repository, "sample", "package.json"), '{"private":true}\n'),
    writeFile(join(repository, "sample", "test", "smoke.test.mjs"), "// discovered fixture\n"),
    writeFile(join(repository, "packages", "contracts", "package.json"), '{"private":true}\n'),
    writeFile(join(repository, "devices", ".keep"), "\n"),
  ]);
  await git(repository, ["init", "-q", "-b", "main"]);
  await git(repository, ["config", "user.name", "Review Environment Control"]);
  await git(repository, ["config", "user.email", "review-control@example.invalid"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-q", "--no-gpg-sign", "-m", "baseline"]);
  await git(repository, ["switch", "-q", "-c", "candidate"]);
  await writeFile(join(repository, "candidate.txt"), "candidate\n");
  await git(repository, ["add", "candidate.txt"]);
  await git(repository, ["commit", "-q", "--no-gpg-sign", "-m", "candidate"]);

  await mkdir(join(repository, "sample", "node_modules"));
  await writeFile(join(repository, "sample", "node_modules", "dependency.txt"), "staged\n");
  await executable(join(fakeBin, "node"), `#!/bin/sh
set -eu
case "\${TMPDIR:-}" in
  "$REVIEW_REPOSITORY_ROOT/.git/run-tests"/run.*/tmp) ;;
  *) echo "fake node observed non-review TMPDIR: \${TMPDIR:-unset}" >&2; exit 91 ;;
esac
printf '%s\\n' "$TMPDIR" >> "$REVIEW_TMPDIR_LOG"
if [ "\${REVIEW_CAPTURE_EVIDENCE:-0}" = "1" ]; then
  printf '%s\\n' "\${PDR_CHROME_EVIDENCE_DIR:-unset}" >> "$REVIEW_EVIDENCE_LOG"
  mkdir -p "$PDR_CHROME_EVIDENCE_DIR/navigation-controlled"
  if [ ! -f "$PDR_CHROME_EVIDENCE_DIR/navigation-controlled/evidence.txt" ]; then
    printf 'retained before extraction cleanup\\n' > "$PDR_CHROME_EVIDENCE_DIR/navigation-controlled/evidence.txt"
  fi
fi
if [ "\${1:-}" = "-e" ]; then exit 1; fi
if [ "\${1:-}" = "--test" ]; then
  if [ "\${REVIEW_FAIL_SUITE:-0}" = "1" ]; then
    cat <<'EOF'
${failingSuiteOutput}
EOF
    exit 1
  fi
  printf 'x pass 1\\nx fail 0\\n'
fi
exit 0
`);
  await executable(join(fakeBin, "npx"), "#!/bin/sh\nexit 0\n");
  if (failingCopy) {
    await executable(join(fakeBin, "cp"), "#!/bin/sh\necho 'cp: Disk quota exceeded' >&2\nexit 1\n");
  }
  if (failingLogWrite) {
    await executable(join(fakeBin, "mkdir"), `#!/bin/sh
set -eu
/usr/bin/mkdir "$@"
for argument in "$@"; do
  case "$argument" in
    */.git/run-tests/failures) chmod 500 "$argument" ;;
  esac
done
`);
  }

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    TMPDIR: ambientTmp,
    REVIEW_FAIL_SUITE: failingSuite ? "1" : "0",
    REVIEW_TMPDIR_LOG: tmpdirLog,
    REVIEW_EVIDENCE_LOG: evidenceLog,
    REVIEW_REPOSITORY_ROOT: repository,
  };
  delete env.NODE_OPTIONS;
  return {
    ambientTmp,
    branch: "candidate",
    env,
    failureLogs: join(repository, ".git", "run-tests", "failures"),
    repository,
    script,
    readTmpdirLog: () => readFile(tmpdirLog, "utf8"),
    readEvidenceLog: () => readFile(evidenceLog, "utf8"),
  };
}

async function executable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function git(repository, arguments_) {
  await execute("git", arguments_, { cwd: repository });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
