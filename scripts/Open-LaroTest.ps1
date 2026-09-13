param(
    [Parameter(Mandatory = $true)][string]$Config,
    [Parameter(Mandatory = $true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
try {
    & (Join-Path $PSScriptRoot 'Start-LaroWorkspace.ps1') -Config $Config -NodePath $NodePath -NoBrowser -ShowErrors
    & $NodePath (Join-Path $PSScriptRoot 'open-local-test.mjs') --config $Config
    if ($LASTEXITCODE -ne 0) { throw 'De lokale testtoegang kon niet worden geopend.' }
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'LARO testtoegang', 'OK', 'Error') | Out-Null
    exit 1
}
