[CmdletBinding()]
param(
    [string]$ComposeProjectName = "",
    [switch]$KeepContainer
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $root ".laro-ngrok.json"

Set-Location -LiteralPath $root

function Get-EnvValue {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    $entry = Get-Content -LiteralPath $Path |
        Where-Object { $_ -match "^$([regex]::Escape($Name))=" } |
        Select-Object -Last 1
    if (-not $entry) { return "" }
    return ($entry -split "=", 2)[1].Trim()
}

$envPath = Join-Path $root ".env"
$runtime = $null

if (Test-Path -LiteralPath $runtimePath) {
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    if ($runtime.ngrokPid) {
        $process = Get-Process -Id ([int]$runtime.ngrokPid) -ErrorAction SilentlyContinue
        if ($process) {
            if ($process.ProcessName -ne "ngrok") {
                throw "Recorded PID $($runtime.ngrokPid) no longer belongs to ngrok; refusing to stop it."
            }

            $processDetails = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.ngrokPid)"
            if (-not $processDetails.CommandLine -or $processDetails.CommandLine -notmatch "laro-api") {
                throw "Recorded ngrok process is not the LARO tunnel; refusing to stop it."
            }
            Stop-Process -Id $process.Id -Force
        }
    }
    Remove-Item -LiteralPath $runtimePath -Force
}

if (-not $ComposeProjectName -and $runtime.composeProjectName) {
    $ComposeProjectName = [string]$runtime.composeProjectName
}
if (-not $ComposeProjectName) {
    $ComposeProjectName = Get-EnvValue -Path $envPath -Name "LARO_COMPOSE_PROJECT_NAME"
}
if (-not $ComposeProjectName) { $ComposeProjectName = "laro" }
$ComposeProjectName = $ComposeProjectName.Trim().ToLowerInvariant()
if ($ComposeProjectName -notmatch "^[a-z0-9][a-z0-9_-]*$") {
    throw "ComposeProjectName must use lowercase letters, digits, dashes, or underscores."
}

if (-not $KeepContainer) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "docker is required but was not found on PATH."
    }
    & docker compose -p $ComposeProjectName stop laro-server
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed to stop LARO." }
}

Write-Host "LARO ngrok API deployment stopped."
