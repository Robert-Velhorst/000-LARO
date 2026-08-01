[CmdletBinding()]
param(
    [string]$GatewayUrl = "",
    [string]$PathPrefix = "",
    [string]$InternalUrl = "",
    [string]$ComposeProjectName = "",
    [switch]$SkipBuild,
    [switch]$SkipPublicCheck
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root ".env"
$runtimePath = Join-Path $root ".laro-ngrok.json"
$providerConfigPath = Join-Path $root ".laro-provider-config.json"
$ngrokLogPath = Join-Path $env:TEMP "laro-ngrok.log"

function Set-EnvValue {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [string]$Value
    )

    $lines = if (Test-Path -LiteralPath $Path) {
        @(Get-Content -LiteralPath $Path)
    } else {
        @()
    }
    $replacement = "$Name=$Value"
    $found = $false
    $updated = foreach ($line in $lines) {
        if ($line -match "^$([regex]::Escape($Name))=") {
            $found = $true
            $replacement
        } else {
            $line
        }
    }
    if (-not $found) {
        $updated += $replacement
    }
    Set-Content -LiteralPath $Path -Value $updated -Encoding utf8
}

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

function New-LocalSecret {
    $bytes = [byte[]]::new(48)
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Unprotect-Secret {
    param([Parameter(Mandatory)] [string]$ProtectedValue)

    $secureValue = ConvertTo-SecureString -String $ProtectedValue
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Assert-GoogleProviderConfig {
    param(
        [Parameter(Mandatory)] [string]$ClientId,
        [Parameter(Mandatory)] [string]$ClientSecret
    )

    if ($ClientId -notmatch "^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$") {
        throw "Protected Google provider configuration contains an invalid web OAuth client ID."
    }
    if ($ClientSecret -notmatch "^[A-Za-z0-9_-]{16,128}$") {
        throw "Protected Google provider configuration contains an invalid client secret. Reconfigure Google before deployment."
    }
}

function Import-ProtectedProviderConfig {
    if (-not (Test-Path -LiteralPath $providerConfigPath)) { return }

    $config = Get-Content -LiteralPath $providerConfigPath -Raw | ConvertFrom-Json
    if ($config.schemaVersion -ne 1) {
        throw "Unsupported provider configuration version."
    }
    if ($config.google) {
        if (-not $config.google.clientId -or -not $config.google.clientSecretProtected) {
            throw "Protected Google provider configuration is incomplete."
        }
        $googleClientSecret = Unprotect-Secret -ProtectedValue $config.google.clientSecretProtected
        Assert-GoogleProviderConfig -ClientId $config.google.clientId -ClientSecret $googleClientSecret
        $env:GOOGLE_CLIENT_ID = $config.google.clientId
        $env:GOOGLE_CLIENT_SECRET = $googleClientSecret
        $googleClientSecret = $null
    }
    if ($config.outboundEmail) {
        if (
            $config.outboundEmail.provider -ne "smtp" -or
            -not $config.outboundEmail.host -or
            -not $config.outboundEmail.user -or
            -not $config.outboundEmail.passwordProtected -or
            -not $config.outboundEmail.from
        ) {
            throw "Protected outbound-email configuration is incomplete or unsupported."
        }
        $env:EMAIL_PROVIDER = "smtp"
        $env:SMTP_HOST = $config.outboundEmail.host
        $env:SMTP_PORT = [string]$config.outboundEmail.port
        $env:SMTP_USER = $config.outboundEmail.user
        $env:SMTP_PASS = Unprotect-Secret -ProtectedValue $config.outboundEmail.passwordProtected
        $env:SMTP_FROM = $config.outboundEmail.from
        $env:SMTP_STARTTLS = if ($config.outboundEmail.startTls) { "true" } else { "false" }
    }
}

function Wait-ForJsonEndpoint {
    param(
        [Parameter(Mandatory)] [string]$Uri,
        [int]$Attempts = 60,
        [int]$DelayMilliseconds = 1000
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            return Invoke-RestMethod -Uri $Uri -TimeoutSec 5
        } catch {
            if ($attempt -eq $Attempts) { throw }
            Start-Sleep -Milliseconds $DelayMilliseconds
        }
    }
}

function Wait-ForHttpsTunnel {
    param(
        [Parameter(Mandatory)] [Diagnostics.Process]$Process,
        [Parameter(Mandatory)] [string]$ExpectedUrl,
        [int]$Attempts = 60
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if ($Process.HasExited) {
            throw "ngrok exited before registering an HTTPS tunnel."
        }
        try {
            $state = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 5
            $httpsTunnel = @($state.tunnels) |
                Where-Object { $_.public_url.TrimEnd("/") -eq $ExpectedUrl.TrimEnd("/") } |
                Select-Object -First 1
            if ($httpsTunnel) { return $httpsTunnel }
        } catch {
            if ($attempt -eq $Attempts) { throw }
        }
        Start-Sleep -Milliseconds 1000
    }
    throw "ngrok did not report an HTTPS tunnel."
}

Set-Location -LiteralPath $root

foreach ($command in "docker", "ngrok") {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "$command is required but was not found on PATH."
    }
}

& ngrok config check | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "ngrok account configuration is invalid."
}

if (-not (Test-Path -LiteralPath $envPath)) {
    $examplePath = Join-Path $root ".env.example"
    if (-not (Test-Path -LiteralPath $examplePath)) {
        throw "LARO environment template was not found."
    }
    Copy-Item -LiteralPath $examplePath -Destination $envPath
}

foreach ($name in "JWT_SECRET", "COOKIE_SECRET") {
    $value = Get-EnvValue -Path $envPath -Name $name
    if ($value.Length -lt 32 -or $value -match "^change-this") {
        Set-EnvValue -Path $envPath -Name $name -Value (New-LocalSecret)
    }
}
Set-EnvValue -Path $envPath -Name "NODE_ENV" -Value "production"
Import-ProtectedProviderConfig

$configuredComposeProject = Get-EnvValue -Path $envPath -Name "LARO_COMPOSE_PROJECT_NAME"
if (-not $ComposeProjectName) {
    $ComposeProjectName = if ($configuredComposeProject) { $configuredComposeProject } else { "laro" }
}
$ComposeProjectName = $ComposeProjectName.Trim().ToLowerInvariant()
if ($ComposeProjectName -notmatch "^[a-z0-9][a-z0-9_-]*$") {
    throw "ComposeProjectName must use lowercase letters, digits, dashes, or underscores."
}
Set-EnvValue -Path $envPath -Name "LARO_COMPOSE_PROJECT_NAME" -Value $ComposeProjectName

if (-not $GatewayUrl) { $GatewayUrl = Get-EnvValue -Path $envPath -Name "LARO_NGROK_GATEWAY_URL" }
if (-not $PathPrefix) { $PathPrefix = Get-EnvValue -Path $envPath -Name "LARO_NGROK_PATH_PREFIX" }
if (-not $InternalUrl) { $InternalUrl = Get-EnvValue -Path $envPath -Name "LARO_NGROK_INTERNAL_URL" }
if (-not $GatewayUrl) { throw "GatewayUrl is required (for example, https://example.ngrok-free.dev)." }
if (-not $PathPrefix) { $PathPrefix = "/laro" }
if (-not $InternalUrl) { $InternalUrl = "https://laro.internal" }

$gatewayUri = [Uri]$GatewayUrl
if (
    $gatewayUri.Scheme -ne "https" -or
    -not $gatewayUri.Host -or
    $gatewayUri.UserInfo -or
    $gatewayUri.AbsolutePath -ne "/" -or
    $gatewayUri.Query -or
    $gatewayUri.Fragment
) {
    throw "GatewayUrl must be an HTTPS origin."
}
$publicOrigin = $gatewayUri.GetLeftPart([UriPartial]::Authority).TrimEnd("/")
$prefixValue = $PathPrefix.Trim().Trim("/")
$invalidPrefixSegment = @($prefixValue -split "/") |
    Where-Object { $_ -eq "." -or $_ -eq ".." } |
    Select-Object -First 1
if (
    -not $prefixValue -or
    $prefixValue -notmatch "^[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$" -or
    $invalidPrefixSegment
) {
    throw "PathPrefix must contain a URL-safe path such as /laro."
}
$normalizedPrefix = "/$prefixValue"
$publicBaseUrl = "$publicOrigin$normalizedPrefix"
$packageMetadata = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$env:LARO_APP_VERSION = $packageMetadata.version
$InternalUrl = $InternalUrl.Trim().TrimEnd("/")
if ($InternalUrl -notmatch "^https://[a-z0-9.-]+\.internal$") {
    throw "InternalUrl must be an HTTPS ngrok internal endpoint."
}

Set-EnvValue -Path $envPath -Name "LARO_NGROK_GATEWAY_URL" -Value $publicOrigin
Set-EnvValue -Path $envPath -Name "LARO_NGROK_PATH_PREFIX" -Value $normalizedPrefix
Set-EnvValue -Path $envPath -Name "LARO_NGROK_INTERNAL_URL" -Value $InternalUrl

$ngrokExecutable = (Get-Command ngrok).Source
$ngrokArguments = @(
    "http",
    "http://127.0.0.1:3000",
    "--inspect=true",
    "--log=$ngrokLogPath",
    "--log-format=json",
    "--name=laro-api",
    "--url=$InternalUrl"
)

$ngrokProcess = $null
$httpsTunnel = $null
$startedNgrok = $false

try {
    $existingState = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 3
    $httpsTunnel = @($existingState.tunnels) |
        Where-Object { $_.public_url.TrimEnd("/") -eq $InternalUrl } |
        Select-Object -First 1
} catch {
    $httpsTunnel = $null
}

$existingNgrok = @(Get-Process ngrok -ErrorAction SilentlyContinue)
if ($httpsTunnel) {
    if ($existingNgrok.Count -ne 1) {
        throw "The LARO tunnel exists, but its local ngrok process could not be identified safely."
    }
    $ngrokProcess = $existingNgrok[0]
} else {
    if ($existingNgrok.Count -gt 0) {
        throw "Another local ngrok process is already running without the expected LARO tunnel."
    }
    $ngrokProcess = Start-Process -FilePath $ngrokExecutable `
        -ArgumentList $ngrokArguments `
        -PassThru `
        -WindowStyle Hidden
    $startedNgrok = $true
}

try {
    if (-not $httpsTunnel) {
        $httpsTunnel = Wait-ForHttpsTunnel -Process $ngrokProcess -ExpectedUrl $InternalUrl
    }
    $env:LARO_PUBLIC_ORIGIN = $publicOrigin
    $env:LARO_PUBLIC_BASE_URL = $publicBaseUrl
    $env:LARO_PUBLIC_PATH_PREFIX = $normalizedPrefix

    $composeArguments = @("compose", "-p", $ComposeProjectName, "up", "-d")
    if (-not $SkipBuild) { $composeArguments += "--build" }
    & docker @composeArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed to start LARO." }

    $localHealth = Wait-ForJsonEndpoint -Uri "http://127.0.0.1:3000/api/health" -Attempts 120
    if ($localHealth.status -ne "healthy") {
        throw "LARO local health verification did not report healthy."
    }
    $publicHealth = $null
    if (-not $SkipPublicCheck) {
        $publicHealth = Wait-ForJsonEndpoint -Uri "$publicBaseUrl/api/health" -Attempts 30
        if ($publicHealth.status -ne "healthy") {
            throw "LARO public health verification did not report healthy."
        }
    }

    [ordered]@{
        publicUrl = $publicBaseUrl
        healthUrl = "$publicBaseUrl/api/health"
        internalUrl = $httpsTunnel.public_url
        ngrokPid = $ngrokProcess.Id
        composeProjectName = $ComposeProjectName
        startedAt = (Get-Date).ToUniversalTime().ToString("o")
        version = $localHealth.version
        publicVerified = [bool]$publicHealth
    } | ConvertTo-Json | Set-Content -LiteralPath $runtimePath -Encoding utf8

    Write-Host "LARO API is healthy on its ngrok internal endpoint: $InternalUrl"
    if ($publicHealth) {
        Write-Host "Public API: $publicBaseUrl"
        Write-Host "Health: $publicBaseUrl/api/health"
    } else {
        Write-Host "Public check skipped until the gateway path policy is installed."
    }
    Write-Host "Runtime metadata: $runtimePath"
} catch {
    if ($startedNgrok -and -not $ngrokProcess.HasExited) {
        Stop-Process -Id $ngrokProcess.Id -Force -ErrorAction SilentlyContinue
    }
    throw
}
