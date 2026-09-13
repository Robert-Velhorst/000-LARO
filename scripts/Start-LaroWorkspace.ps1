param(
    [Parameter(Mandatory = $true)][string]$Config,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [switch]$NoBrowser,
    [switch]$ShowErrors
)

$ErrorActionPreference = 'Stop'
$mutex = $null
$locked = $false
try {
    $configPath = (Resolve-Path -LiteralPath $Config).Path
    $node = (Resolve-Path -LiteralPath $NodePath).Path
    $settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $port = [int]$settings.port
    if ($port -lt 1024 -or $port -gt 65535) { throw 'Invalid workspace port.' }
    $repo = Split-Path -Parent $PSScriptRoot
    $launcher = Join-Path $PSScriptRoot 'start-local-workspace.mjs'
    $entry = Join-Path $repo 'dist\server\server\index.js'
    $url = "http://127.0.0.1:$port/"
    $logRoot = Split-Path -Parent $configPath
    $stdout = Join-Path $logRoot 'workspace.stdout.log'
    $stderr = Join-Path $logRoot 'workspace.stderr.log'

    # Serialize repeated clicks, including the period before the server binds.
    $mutex = New-Object System.Threading.Mutex($false, "Local\LaroWorkspacePort$port")
    try { $locked = $mutex.WaitOne(180000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another LARO startup is still in progress.' }

    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        $server = Get-CimInstance Win32_Process -Filter "ProcessId=$($listeners[0].OwningProcess)"
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($server.ParentProcessId)"
        if (-not $server.CommandLine.Contains($entry) -or -not $parent.CommandLine.Contains($launcher) -or -not $parent.CommandLine.Contains($configPath)) {
            throw "Port $port belongs to another process. Nothing was stopped or replaced."
        }
    } else {
        $arguments = '"{0}" --config "{1}"' -f $launcher, $configPath
        $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    }

    $ready = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(150)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($process -and $process.HasExited) { throw "LARO stopped during startup. See $stderr" }
        try {
            $health = Invoke-RestMethod -Uri "${url}api/ready" -TimeoutSec 3
            if ($health.status -eq 'ready' -and $health.dbReady -eq $true) { $ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw "LARO did not become ready in time. See $stdout and $stderr" }
    Write-Output "LARO ready: $url"
    if (-not $NoBrowser) { Start-Process $url }
} catch {
    if ($ShowErrors) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'LARO kon niet starten', 'OK', 'Error') | Out-Null
    }
    Write-Error $_
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
