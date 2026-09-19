import { chmod, cp, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_PACKAGE_TARGETS, packageArchiveName, packageTarget } from "./targets.mjs";

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const WINDOWS_NATIVE_REDIRECTION_STDOUT = "native stdout survived process-level redirection";
export const WINDOWS_NATIVE_REDIRECTION_STDERR = "native stderr must remain one exact process-written line even when this deliberately long assertion phrase crosses a narrow Windows PowerShell 5.1 host buffer width without formatter prefixes, inserted line breaks, or trailing ErrorRecord metadata";
export const WINDOWS_NATIVE_REDIRECTION_ARGUMENT = "C:\\pdr smoke control\\a file.pdpkg";

/** Stage the data and shell program that execute inside the isolated context. */
export async function stagePackageSmokePayload({
  target: targetId,
  archivePath,
  outputDirectory,
  sourceDirectory = defaultRepositoryRoot,
} = {}) {
  if (targetId === undefined) throw new TypeError("target is required");
  if (archivePath === undefined) throw new TypeError("archivePath is required");
  if (outputDirectory === undefined) throw new TypeError("outputDirectory is required");
  const target = packageTarget(targetId);
  const archive = resolve(archivePath);
  const output = resolve(outputDirectory);
  const sourceRoot = resolve(sourceDirectory);
  await assertFile(archive, "package archive");
  await Promise.all([
    mkdir(join(output, "fixtures"), { recursive: true }),
    mkdir(join(output, "input"), { recursive: true }),
  ]);
  const archiveName = packageArchiveName(target);
  const stagedArchive = join(output, "input", archiveName);
  await cp(archive, stagedArchive);

  await cp(
    join(sourceRoot, "tools", "package", "web-smoke-client.mjs"),
    join(output, "fixtures", "web-smoke-client.mjs"),
  );
  if (target.os === "win32") {
    await writeFile(
      join(output, "fixtures", "native-redirection-control.mjs"),
      `const expectedArgument = ${JSON.stringify(WINDOWS_NATIVE_REDIRECTION_ARGUMENT)};\n`
        + "if (process.argv.length !== 3 || process.argv[2] !== expectedArgument) {\n"
        + "  process.stderr.write(\"native argv mismatch: \" + JSON.stringify(process.argv.slice(2)) + \"\\n\");\n"
        + "  process.exitCode = 91;\n"
        + "} else {\n"
        + `  process.stdout.write(${JSON.stringify(`${WINDOWS_NATIVE_REDIRECTION_STDOUT}\n`)});\n`
        + `  process.stderr.write(${JSON.stringify(`${WINDOWS_NATIVE_REDIRECTION_STDERR}\n`)});\n`
        + "  process.exitCode = 23;\n"
        + "}\n",
    );
  }
  const scriptPath = join(output, target.os === "win32" ? "smoke.ps1" : "smoke.sh");
  await writeFile(
    scriptPath,
    target.os === "win32" ? windowsSmokeScript(target) : smokeScript(target),
    { mode: target.os === "win32" ? 0o644 : 0o755 },
  );
  if (target.os !== "win32") await chmod(scriptPath, 0o755);
  return Object.freeze({ outputDirectory: output, scriptPath, stagedArchive });
}

function smokeScript(target) {
  const archiveName = packageArchiveName(target);
  const wrongGuideAssertions = Object.keys(CLI_PACKAGE_TARGETS)
    .filter((id) => id !== target.id)
    .map((id) => `test ! -e "$package_root/docs/${id}-package.md"`)
    .join("\n");
  const ioctlAssertion = target.nativeInputs.ioctl === undefined
    ? `grep -F '"ioctl":{"required":false' "$work_root/native.txt" >/dev/null`
    : `grep -F '"ioctl":{"required":true,"loaded":true' "$work_root/native.txt" >/dev/null`;
  const nativeSummary = target.nativeInputs.ioctl === undefined
    ? "serialport and usb initialized; POSIX ioctl correctly absent"
    : "serialport, usb and ioctl initialized";
  return `#!/bin/sh
set -eux

if command -v node >/dev/null 2>&1; then
  echo "smoke environment unexpectedly contains Node" >&2
  exit 70
fi
if command -v npm >/dev/null 2>&1 || command -v cc >/dev/null 2>&1; then
  echo "smoke environment unexpectedly contains a build toolchain" >&2
  exit 71
fi

smoke_root=\${PDR_SMOKE_ROOT:-/smoke}
work_root=\${TMPDIR:-/tmp}/protodriver-package-smoke
rm -rf "$work_root"
mkdir -p "$work_root"
tar -xzf "$smoke_root/input/${archiveName}" -C "$work_root"
package_root="$work_root/${target.packageRootName}"
test -x "$package_root/bin/node"
test -x "$package_root/bin/pdr"
test -x "$package_root/bin/pdr-web"
test -f "$package_root/README.md"
test -f "$package_root/docs/author-tutorial.md"
test -f "$package_root/docs/declaration-reference.md"
test -f "$package_root/docs/cli-reference.md"
test -f "$package_root/docs/${target.id}-package.md"
test -f "$package_root/examples/start/device.lua"
test -f "$package_root/examples/demo-thermostat/README.md"
test -f "$package_root/examples/ti84-plus-ce/transcript.txt"
${wrongGuideAssertions}

web_stdout="$work_root/web-stdout.txt"
web_stderr="$work_root/web-stderr.txt"
PDR_WEB_PORT=0 "$package_root/bin/pdr-web" > "$web_stdout" 2> "$web_stderr" &
web_pid=$!
stop_web() {
  if kill -0 "$web_pid" 2>/dev/null; then
    kill "$web_pid"
    wait "$web_pid" || true
  fi
}
trap stop_web EXIT HUP INT TERM
"$package_root/bin/node" "$smoke_root/fixtures/web-smoke-client.mjs" \
  "$package_root" "$web_stdout"
stop_web
trap - EXIT HUP INT TERM

"$package_root/bin/pdr" pack "$package_root/examples/device-2" "$work_root/device-2.package-data" > "$work_root/pack.txt"
grep -E 'source-set sha256:[0-9a-f]{64}' "$work_root/pack.txt" >/dev/null
"$package_root/bin/pdr" run "$work_root/device-2.package-data" --help > "$work_root/package-help.txt"
grep -F 'device-2-authored (device-2-authored, device/v2)' "$work_root/package-help.txt" >/dev/null
grep -F 'get_rate: Get sample rate' "$work_root/package-help.txt" >/dev/null

set +e
"$package_root/bin/pdr" run "$work_root/device-2.package-data" --mode interactive get_rate > "$work_root/run.txt" 2> "$work_root/run-error.txt"
run_status=$?
set -e
test "$run_status" -ne 0
grep -F 'no candidate matches connection profile' "$work_root/run-error.txt" >/dev/null

"$package_root/bin/node" "$package_root/app/native-smoke.ts" > "$work_root/native.txt"
grep -F '"serialport":{"loaded":true' "$work_root/native.txt" >/dev/null
grep -F '"usb":{"loaded":true' "$work_root/native.txt" >/dev/null
${ioctlAssertion}

echo "package-${target.id} smoke: archive unpacked; author material checked; web assets served; contract-2 pdpkg packed and admitted; ${nativeSummary}"
`;
}

function windowsSmokeScript(target) {
  const archiveName = packageArchiveName(target);
  const wrongGuideAssertions = Object.keys(CLI_PACKAGE_TARGETS)
    .filter((id) => id !== target.id)
    .map((id) => `  Assert-True (-not (Test-Path -LiteralPath (Join-Path $packageRoot "docs\\${id}-package.md"))) "wrong target guide ${id} was packaged"`)
    .join("\n");
  return `$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-True([bool] $condition, [string] $message) {
  if (-not $condition) { throw $message }
}

function Invoke-ExpectedNativeFailure(
  [string] $Command,
  [string[]] $Arguments,
  [string] $StdoutPath,
  [string] $StderrPath
) {
  # Windows PowerShell 5.1 turns shell-redirected native stderr into formatted
  # ErrorRecord objects. Process-level redirection preserves the child bytes
  # and makes the exit status independent of ErrorActionPreference.
  # Start-Process joins its argument array into .NET Framework's one Arguments
  # string, so quote every element before that join. Smoke arguments are fixed
  # tokens or Windows paths, where a literal double quote is not valid.
  $quotedArguments = @($Arguments | ForEach-Object {
    if ($_.Contains('"')) { throw "native smoke arguments cannot contain a literal double quote" }
    '"{0}"' -f $_
  })
  $process = Start-Process -FilePath $Command -ArgumentList $quotedArguments -NoNewWindow -Wait -PassThru -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath
  return $process.ExitCode
}

foreach ($command in @("node.exe", "npm.cmd", "cl.exe")) {
  if (Get-Command $command -CommandType Application -ErrorAction SilentlyContinue) {
    throw "smoke environment unexpectedly contains $command"
  }
}

$smokeRoot = $PSScriptRoot
$workRoot = Join-Path ([IO.Path]::GetTempPath()) ("protodriver-package-smoke-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workRoot | Out-Null
$smokePassed = $false
try {
  $archive = Join-Path $smokeRoot "input\\${archiveName}"
  Expand-Archive -LiteralPath $archive -DestinationPath $workRoot
  $packageRoot = Join-Path $workRoot "${target.packageRootName}"
  $node = Join-Path $packageRoot "bin\\node.exe"
  $pdr = Join-Path $packageRoot "bin\\pdr.cmd"
  $pdrWeb = Join-Path $packageRoot "bin\\pdr-web.cmd"
  Assert-True (Test-Path -LiteralPath $node -PathType Leaf) "bundled node.exe is missing"
  Assert-True (Test-Path -LiteralPath $pdr -PathType Leaf) "pdr.cmd is missing"
  Assert-True (Test-Path -LiteralPath $pdrWeb -PathType Leaf) "pdr-web.cmd is missing"
  Assert-True (Test-Path -LiteralPath (Join-Path $packageRoot "README.md") -PathType Leaf) "release README is missing"
  Assert-True (Test-Path -LiteralPath (Join-Path $packageRoot "docs\\author-tutorial.md") -PathType Leaf) "author tutorial is missing"
  Assert-True (Test-Path -LiteralPath (Join-Path $packageRoot "docs\\declaration-reference.md") -PathType Leaf) "declaration reference is missing"
  Assert-True (Test-Path -LiteralPath (Join-Path $packageRoot "docs\\cli-reference.md") -PathType Leaf) "CLI reference is missing"
  Assert-True (Test-Path -LiteralPath (Join-Path $packageRoot "docs\\${target.id}-package.md") -PathType Leaf) "target guide is missing"
  Assert-True (Test-Path -LiteralPath (Join-Path $packageRoot "examples\\start\\device.lua") -PathType Leaf) "blank starter is missing"
  Assert-True (Test-Path -LiteralPath (Join-Path $packageRoot "examples\\demo-thermostat\\README.md") -PathType Leaf) "thermostat walkthrough is missing"
  Assert-True (Test-Path -LiteralPath (Join-Path $packageRoot "examples\\ti84-plus-ce\\transcript.txt") -PathType Leaf) "CE transcript is missing"
${wrongGuideAssertions}

  $webStdoutPath = Join-Path $workRoot "web-stdout.txt"
  $webStderrPath = Join-Path $workRoot "web-stderr.txt"
  $priorWebPort = $env:PDR_WEB_PORT
  $env:PDR_WEB_PORT = "0"
  $webProcess = $null
  try {
    $webProcess = Start-Process -FilePath $pdrWeb -NoNewWindow -PassThru -RedirectStandardOutput $webStdoutPath -RedirectStandardError $webStderrPath
    & $node (Join-Path $smokeRoot "fixtures\\web-smoke-client.mjs") $packageRoot $webStdoutPath
    Assert-True ($LASTEXITCODE -eq 0) "packaged web fetch smoke failed"
  } finally {
    $env:PDR_WEB_PORT = $priorWebPort
    if ($null -ne $webProcess -and -not $webProcess.HasExited) {
      & "$env:SystemRoot\\System32\\taskkill.exe" /PID $webProcess.Id /T /F | Out-Null
      Assert-True ($LASTEXITCODE -eq 0) "could not stop packaged web server"
      $webProcess.WaitForExit()
    }
  }

  $controlStdoutPath = Join-Path $workRoot "native-control-stdout.txt"
  $controlStderrPath = Join-Path $workRoot "native-control-stderr.txt"
  $controlArgument = "${WINDOWS_NATIVE_REDIRECTION_ARGUMENT}"
  $controlArguments = @(
    (Join-Path $smokeRoot "fixtures\\native-redirection-control.mjs"),
    $controlArgument
  )
  $controlStatus = Invoke-ExpectedNativeFailure $node $controlArguments $controlStdoutPath $controlStderrPath
  Assert-True ($controlStatus -eq 23) "native redirection control returned the wrong status"
  $controlStdout = Get-Content -Raw -LiteralPath $controlStdoutPath
  $controlStderr = Get-Content -Raw -LiteralPath $controlStderrPath
  Assert-True ($controlStdout.Contains("${WINDOWS_NATIVE_REDIRECTION_STDOUT}")) "native redirection control changed stdout"
  Assert-True ($controlStderr.Contains("${WINDOWS_NATIVE_REDIRECTION_STDERR}")) "native redirection control changed stderr"

  $builtPackage = Join-Path $workRoot "device-2.package-data"
  $pack = & $pdr pack (Join-Path $packageRoot "examples\\device-2") $builtPackage
  Assert-True ($LASTEXITCODE -eq 0) "pdr pack failed"
  $packText = $pack -join [Environment]::NewLine
  Assert-True ($packText -match "source-set sha256:[0-9a-f]{64}") "pack omitted the derived source-set identity"
  $packageHelp = & $pdr run $builtPackage --help
  Assert-True ($LASTEXITCODE -eq 0) "packed contract-2 content did not admit"
  $packageHelpText = $packageHelp -join [Environment]::NewLine
  Assert-True ($packageHelpText.Contains("device-2-authored (device-2-authored, device/v2)")) "authored package help omitted its identity"
  Assert-True ($packageHelpText.Contains("get_rate: Get sample rate")) "authored package help omitted get_rate"

  $runStdoutPath = Join-Path $workRoot "run-stdout.txt"
  $runStderrPath = Join-Path $workRoot "run-stderr.txt"
  $runArguments = @(
    "run", $builtPackage,
    "--mode", "interactive", "get_rate"
  )
  $runStatus = Invoke-ExpectedNativeFailure $pdr $runArguments $runStdoutPath $runStderrPath
  Assert-True ($runStatus -ne 0) "generated command unexpectedly found a device"
  $runStdout = Get-Content -Raw -LiteralPath $runStdoutPath
  $runStderr = Get-Content -Raw -LiteralPath $runStderrPath
  Assert-True ($runStderr.Contains("no candidate matches connection profile")) "run failed before device discovery"

  $workerStdoutPath = Join-Path $workRoot "worker-stdout.txt"
  $workerStderrPath = Join-Path $workRoot "worker-stderr.txt"
  $workerArguments = @(
    "--worker", "run", $builtPackage,
    "--mode", "interactive", "get_rate"
  )
  $workerRunStatus = Invoke-ExpectedNativeFailure $pdr $workerArguments $workerStdoutPath $workerStderrPath
  Assert-True ($workerRunStatus -ne 0) "worker command unexpectedly found a device"
  $workerStdout = Get-Content -Raw -LiteralPath $workerStdoutPath
  $workerStderr = Get-Content -Raw -LiteralPath $workerStderrPath
  $workerFailure = $workerStderr | ConvertFrom-Json
  Assert-True ($workerFailure.category -eq "invocation") "worker serial refusal has the wrong category"
  Assert-True ($workerFailure.error.responsibility -eq "invocation") "worker serial refusal has the wrong responsibility"
  Assert-True ($workerFailure.error.code -eq "authored.acquisition.worker-serial-unavailable") "worker serial refusal has the wrong code"

  $nativeText = & $node (Join-Path $packageRoot "app\\native-smoke.js")
  Assert-True ($LASTEXITCODE -eq 0) "native smoke failed"
  $native = $nativeText | ConvertFrom-Json
  Assert-True ($native.serialport.loaded -eq $true) "serialport did not load"
  Assert-True ($native.usb.loaded -eq $true) "usb did not load"
  Assert-True ($native.ioctl.required -eq $false) "Windows unexpectedly requires POSIX ioctl"
  Assert-True ($native.ioctl.PSObject.Properties.Name -notcontains "loaded") "Windows unexpectedly loaded POSIX ioctl"

  $smokePassed = $true
  Write-Output "package-${target.id} smoke: archive unpacked; author material checked; web assets served; native stream redirection preserved; contract-2 pdpkg packed and admitted; serialport and usb initialized; POSIX ioctl correctly absent"
} finally {
  if ($smokePassed -and (Test-Path -LiteralPath $workRoot)) {
    Remove-Item -LiteralPath $workRoot -Recurse -Force
  } elseif (Test-Path -LiteralPath $workRoot) {
    Write-Warning "smoke failed; retained stdout, stderr, and extracted files at $workRoot"
  }
}
`;
}

async function assertFile(path, subject) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`smoke-package.input-missing: ${subject} at ${path}`);
}
