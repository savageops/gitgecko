$ErrorActionPreference = 'Stop'

$root = Join-Path $env:RUNNER_TEMP 'gitgecko windows followup ünicode'
$repo = Join-Path $root 'repo with spaces ünicode'
$homeDir = Join-Path $root 'home'
$cache = Join-Path $root 'npm-cache'
New-Item -ItemType Directory -Force -Path $repo, $homeDir, $cache | Out-Null
$env:HOME = $homeDir
$env:npm_config_cache = $cache
$env:npm_config_update_notifier = 'false'
$env:npm_config_fund = 'false'
$env:npm_config_audit = 'false'
$env:ANTHROPIC_API_KEY = ''
$env:OPENAI_API_KEY = ''
$env:GITGECKO_LOCAL_BASE_URL = ''

function Invoke-GitGecko {
  param(
    [string]$Name,
    [string[]]$Arguments
  )
  $stdout = Join-Path $env:RUNNER_TEMP "$Name.stdout"
  $stderr = Join-Path $env:RUNNER_TEMP "$Name.stderr"
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  & npx.cmd --yes gitgecko@latest @Arguments 1> $stdout 2> $stderr
  $code = $LASTEXITCODE
  $watch.Stop()
  return [ordered]@{
    exit = $code
    durationMs = [Math]::Round($watch.Elapsed.TotalMilliseconds, 2)
    stdout = (Get-Content -Raw -ErrorAction SilentlyContinue $stdout)
    stderr = (Get-Content -Raw -ErrorAction SilentlyContinue $stderr)
  }
}

Push-Location $repo
try {
  git init -q
  git config user.name 'GitGecko Windows Followup'
  git config user.email 'windows-followup@gitgecko.invalid'
  Set-Content -Encoding utf8NoBOM tracked.ts 'export const baseline = true;'
  git add tracked.ts
  git commit -qm baseline
  Set-Content -Encoding utf8NoBOM tracked.ts 'export const changed = eval("1+1");'
  Set-Content -Encoding utf8NoBOM 'space ünicode.ts' 'export const apiKey = "WINDOWS_0123456789ABCDEF";'

  $version = Invoke-GitGecko -Name version -Arguments @('version')
  $doctor = Invoke-GitGecko -Name doctor -Arguments @('doctor')
  $implicit = Invoke-GitGecko -Name implicit -Arguments @('review', '--pathway', 'deterministic', '--json')
  $relative = Invoke-GitGecko -Name relative -Arguments @('review', '--pathway', 'deterministic', '--file', 'space ünicode.ts', '--json')
  $absolutePath = (Resolve-Path 'space ünicode.ts').Path
  $absolute = Invoke-GitGecko -Name absolute -Arguments @('review', '--pathway', 'deterministic', '--file', $absolutePath, '--json')
  $agent = Invoke-GitGecko -Name agent -Arguments @('review', '--pathway', 'deterministic', '--agent')
  $unknown = Invoke-GitGecko -Name unknown -Arguments @('review', '--pathway', 'deterministic', '--not-a-real-option', '--json')

  $warm = @()
  1..5 | ForEach-Object {
    $sample = Invoke-GitGecko -Name "warm-$_" -Arguments @('review', '--pathway', 'deterministic', '--json')
    $warm += $sample.durationMs
  }

  function Parse-JsonResult {
    param($Result)
    try {
      $value = $Result.stdout | ConvertFrom-Json -Depth 100
      return [ordered]@{
        parsed = $true
        exit = $Result.exit
        durationMs = $Result.durationMs
        stderr = $Result.stderr
        success = $value.success
        failure = $value.failure
        mergeable = $value.artifact.mergeable
        files = $value.artifact.files
        findings = $value.artifact.findings
      }
    } catch {
      return [ordered]@{
        parsed = $false
        exit = $Result.exit
        durationMs = $Result.durationMs
        stdout = $Result.stdout
        stderr = $Result.stderr
        parseError = $_.Exception.Message
      }
    }
  }

  $summary = [ordered]@{
    environment = [ordered]@{
      platform = 'win32'
      node = (node --version)
      npm = (npm --version)
      root = $root
      repo = $repo
      absolutePath = $absolutePath
    }
    version = $version
    doctor = $doctor
    implicit = Parse-JsonResult $implicit
    relativeUnicodePath = Parse-JsonResult $relative
    absoluteUnicodePath = Parse-JsonResult $absolute
    agent = $agent
    unknownFlag = Parse-JsonResult $unknown
    warmReviewDurationsMs = $warm
  }
  $summary | ConvertTo-Json -Depth 100 | Set-Content -Encoding utf8NoBOM (Join-Path $env:RUNNER_TEMP 'windows-followup.json')
  $summary | ConvertTo-Json -Depth 100
} finally {
  Pop-Location
}
