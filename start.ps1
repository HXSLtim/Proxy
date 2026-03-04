[CmdletBinding()]
param(
  [string]$ApiKey,
  [string]$UpstreamUrl,
  [ValidateSet("responses", "chat", "messages")]
  [string]$Target,
  [int]$Port,
  [string]$Model,
  [string]$ForceModelId,
  [string]$ReasoningEffort
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptRoot

function Import-DotEnv {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  Get-Content -Path $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }

    $eqIndex = $line.IndexOf("=")
    if ($eqIndex -lt 1) {
      return
    }

    $name = $line.Substring(0, $eqIndex).Trim()
    $value = $line.Substring($eqIndex + 1).Trim()

    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    $existing = [Environment]::GetEnvironmentVariable($name, "Process")
    if ([string]::IsNullOrWhiteSpace($existing)) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

Import-DotEnv -Path (Join-Path $scriptRoot ".env")

if ([string]::IsNullOrWhiteSpace($ApiKey)) { $ApiKey = $env:RESPONSES_API_KEY }
if ([string]::IsNullOrWhiteSpace($ApiKey)) { $ApiKey = $env:OPENAI_API_KEY }

if ([string]::IsNullOrWhiteSpace($UpstreamUrl)) { $UpstreamUrl = $env:RESPONSES_UPSTREAM_URL }
if ([string]::IsNullOrWhiteSpace($UpstreamUrl)) { $UpstreamUrl = "https://proxy.devaicode.dev/v1/responses" }

if ([string]::IsNullOrWhiteSpace($Target)) { $Target = $env:RESPONSES_TARGET }
if ([string]::IsNullOrWhiteSpace($Target)) { $Target = "responses" }

if (-not $Port) {
  if ($env:PORT -match "^\d+$") {
    $Port = [int]$env:PORT
  } else {
    $Port = 8787
  }
}

if ([string]::IsNullOrWhiteSpace($Model)) { $Model = $env:DEFAULT_MODEL }
if ([string]::IsNullOrWhiteSpace($Model)) { $Model = "gpt-4.1-mini" }

if ([string]::IsNullOrWhiteSpace($ForceModelId)) { $ForceModelId = $env:FORCE_MODEL_ID }
if ([string]::IsNullOrWhiteSpace($ForceModelId)) { $ForceModelId = $Model }

if ([string]::IsNullOrWhiteSpace($ReasoningEffort)) { $ReasoningEffort = $env:FORCE_REASONING_EFFORT }
if ([string]::IsNullOrWhiteSpace($ReasoningEffort)) { $ReasoningEffort = $env:MODEL_REASONING_EFFORT }
if ([string]::IsNullOrWhiteSpace($ReasoningEffort)) { $ReasoningEffort = "medium" }
$ReasoningEffort = $ReasoningEffort.Trim().ToLowerInvariant()
if ($ReasoningEffort -notin @("low", "medium", "high", "xhigh")) {
  throw "ReasoningEffort must be one of: low, medium, high, xhigh"
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  $ApiKey = Read-Host "RESPONSES_API_KEY not found. Please input API key"
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw "Missing API key. Provide -ApiKey or set RESPONSES_API_KEY in .env"
}

$env:RESPONSES_TARGET = $Target
$env:RESPONSES_UPSTREAM_URL = $UpstreamUrl
$env:RESPONSES_API_KEY = $ApiKey
$env:OPENAI_API_KEY = $ApiKey
$env:PORT = [string]$Port
$env:DEFAULT_MODEL = $Model
$env:FORCE_MODEL_ID = $ForceModelId
$env:FORCE_REASONING_EFFORT = $ReasoningEffort
$env:MODEL_REASONING_EFFORT = $ReasoningEffort

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js not found in PATH."
}

$masked = if ($ApiKey.Length -gt 10) {
  "{0}...{1}" -f $ApiKey.Substring(0, 6), $ApiKey.Substring($ApiKey.Length - 4)
} else {
  "***"
}

Write-Host "Starting proxy..."
Write-Host "Target: $Target"
Write-Host "Upstream: $UpstreamUrl"
Write-Host "Port: $Port"
Write-Host "Model: $Model"
Write-Host "Force model: $ForceModelId"
Write-Host "Reasoning effort: $ReasoningEffort"
Write-Host "API key: $masked"

node server.mjs
