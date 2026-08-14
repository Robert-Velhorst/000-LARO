[CmdletBinding()]
param(
    [switch]$Google,
    [switch]$Smtp,
    [switch]$Status,
    [string]$GoogleClientId = "",
    [Security.SecureString]$GoogleClientSecret,
    [string]$GoogleDesktopRedirectBaseUrl = "http://127.0.0.1:8768",
    [string]$SmtpHost = "smtp.gmail.com",
    [ValidateRange(1, 65535)] [int]$SmtpPort = 587,
    [string]$SmtpUser = "",
    [Security.SecureString]$SmtpPassword,
    [string]$SmtpFrom = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$legacyConfigPath = Join-Path $root ".laro-provider-config.json"
if (-not $env:APPDATA) {
    throw "APPDATA is unavailable; the Windows provider configuration location cannot be resolved."
}
$configDirectory = Join-Path $env:APPDATA "LARO Desktop"
$configPath = Join-Path $configDirectory "provider-config.json"

if ($env:OS -ne "Windows_NT") {
    throw "This command requires Windows DPAPI."
}

function Read-RequiredText {
    param(
        [Parameter(Mandatory)] [string]$Prompt,
        [string]$Value = ""
    )

    $result = $Value.Trim()
    while (-not $result) {
        $result = (Read-Host $Prompt).Trim()
    }
    return $result
}

function Assert-EmailAddress {
    param([Parameter(Mandatory)] [string]$Value)

    try {
        $address = [Net.Mail.MailAddress]::new($Value)
    } catch {
        throw "Invalid email address: $Value"
    }
    if ($address.Address -ne $Value) {
        throw "Email addresses must not contain a display name: $Value"
    }
}

function Protect-Secret {
    param([Parameter(Mandatory)] [Security.SecureString]$Value)

    return ConvertFrom-SecureString -SecureString $Value
}

function Assert-GoogleClientSecret {
    param([Parameter(Mandatory)] [Security.SecureString]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        $plainText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($plainText -notmatch "^[A-Za-z0-9_-]{16,128}$") {
            throw "Google client secret must be the token from Google Cloud, not a URL, path, or placeholder."
        }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $plainText = $null
    }
}

function Normalize-SmtpPassword {
    param(
        [Parameter(Mandatory)] [Security.SecureString]$Value,
        [Parameter(Mandatory)] [string]$HostName
    )

    if ($HostName -notmatch "(^|\.)smtp\.gmail\.com$") { return $Value }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        $plainText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $normalized = $plainText -replace "\s", ""
        if ($normalized.Length -ne 16) {
            throw "Gmail SMTP requires a 16-character Google app password."
        }
        return ConvertTo-SecureString $normalized -AsPlainText -Force
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $plainText = $null
        $normalized = $null
    }
}

function Read-ProviderConfig {
    $sourcePath = if (Test-Path -LiteralPath $configPath) {
        $configPath
    } elseif (Test-Path -LiteralPath $legacyConfigPath) {
        $legacyConfigPath
    } else {
        $null
    }
    if (-not $sourcePath) {
        return [ordered]@{
            schemaVersion = 1
            google = $null
            outboundEmail = $null
            updatedAt = $null
        }
    }

    $existing = Get-Content -LiteralPath $sourcePath -Raw | ConvertFrom-Json
    if ($existing.schemaVersion -ne 1) {
        throw "Unsupported provider configuration version."
    }
    return [ordered]@{
        schemaVersion = 1
        google = $existing.google
        outboundEmail = $existing.outboundEmail
        updatedAt = $existing.updatedAt
    }
}

function Write-ProviderConfig {
    param([Parameter(Mandatory)] [Collections.IDictionary]$Config)

    $Config.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
    $temporaryPath = "$configPath.tmp-$PID"
    try {
        $Config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryPath -Encoding utf8
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        & icacls $temporaryPath /inheritance:r /grant:r "*$($currentSid):(F)" "*S-1-5-18:(F)" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not restrict provider configuration permissions."
        }
        Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
    } finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

function Write-ProviderStatus {
    param([Parameter(Mandatory)] [Collections.IDictionary]$Config)

    [ordered]@{
        googleConfigured = [bool](
            $Config.google.clientId -and $Config.google.clientSecretProtected
        )
        outboundEmailConfigured = [bool](
            $Config.outboundEmail.provider -eq "smtp" -and
            $Config.outboundEmail.host -and
            $Config.outboundEmail.user -and
            $Config.outboundEmail.passwordProtected -and
            $Config.outboundEmail.from
        )
        outboundEmailProvider = if ($Config.outboundEmail.provider) {
            $Config.outboundEmail.provider
        } else {
            $null
        }
        protectedBy = "Windows DPAPI CurrentUser"
        storagePath = $configPath
    } | ConvertTo-Json
}

function Assert-DesktopRedirectBaseUrl {
    param([Parameter(Mandatory)] [string]$Value)

    try {
        $uri = [Uri]$Value
    } catch {
        throw "GoogleDesktopRedirectBaseUrl must be a valid loopback HTTP origin."
    }
    if (
        $uri.Scheme -ne "http" -or
        $uri.Host -notin "127.0.0.1", "localhost", "::1" -or
        $uri.IsDefaultPort -or
        $uri.AbsolutePath -ne "/" -or
        $uri.Query -or
        $uri.Fragment -or
        $uri.UserInfo
    ) {
        throw "GoogleDesktopRedirectBaseUrl must be a loopback HTTP origin with an explicit port."
    }
}

$config = Read-ProviderConfig
$configNeedsWrite = -not (Test-Path -LiteralPath $configPath) -and (Test-Path -LiteralPath $legacyConfigPath)
if ($config.google -and -not $config.google.desktopRedirectBaseUrl) {
    Assert-DesktopRedirectBaseUrl -Value $GoogleDesktopRedirectBaseUrl
    $config.google = [ordered]@{
        clientId = $config.google.clientId
        clientSecretProtected = $config.google.clientSecretProtected
        desktopRedirectBaseUrl = $GoogleDesktopRedirectBaseUrl
    }
    $configNeedsWrite = $true
}
if ($configNeedsWrite) {
    Write-ProviderConfig -Config $config
}

if ($Google) {
    $GoogleClientId = Read-RequiredText -Prompt "Google web OAuth client ID" -Value $GoogleClientId
    if ($GoogleClientId -notmatch "^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$") {
        throw "GoogleClientId must be a Google web OAuth client ID."
    }
    if (-not $GoogleClientSecret) {
        $GoogleClientSecret = Read-Host "Google web OAuth client secret" -AsSecureString
    }
    if (-not $GoogleClientSecret -or $GoogleClientSecret.Length -lt 16) {
        throw "Google client secret is missing or too short."
    }
    Assert-GoogleClientSecret -Value $GoogleClientSecret
    Assert-DesktopRedirectBaseUrl -Value $GoogleDesktopRedirectBaseUrl
    $config.google = [ordered]@{
        clientId = $GoogleClientId
        clientSecretProtected = Protect-Secret -Value $GoogleClientSecret
        desktopRedirectBaseUrl = $GoogleDesktopRedirectBaseUrl
    }
}

if ($Smtp) {
    $SmtpHost = Read-RequiredText -Prompt "SMTP host" -Value $SmtpHost
    $SmtpUser = Read-RequiredText -Prompt "SMTP username/email" -Value $SmtpUser
    $SmtpFrom = Read-RequiredText -Prompt "SMTP from address" -Value $SmtpFrom
    Assert-EmailAddress -Value $SmtpFrom
    if (-not $SmtpPassword) {
        $SmtpPassword = Read-Host "SMTP password or Gmail app password" -AsSecureString
    }
    if (-not $SmtpPassword -or $SmtpPassword.Length -lt 8) {
        throw "SMTP password is missing or too short."
    }
    $SmtpPassword = Normalize-SmtpPassword -Value $SmtpPassword -HostName $SmtpHost
    $config.outboundEmail = [ordered]@{
        provider = "smtp"
        host = $SmtpHost
        port = $SmtpPort
        user = $SmtpUser
        passwordProtected = Protect-Secret -Value $SmtpPassword
        from = $SmtpFrom
        startTls = $true
    }
}

if ($Google -or $Smtp) {
    Write-ProviderConfig -Config $config
}

Write-ProviderStatus -Config $config
