[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$ConfigPath
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "Protected provider configuration requires Windows DPAPI."
}

$resolvedPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$config = Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
if ($config.schemaVersion -ne 1) {
    throw "Unsupported provider configuration version."
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

$environment = [ordered]@{}
if ($config.google) {
    if (-not $config.google.clientId -or -not $config.google.clientSecretProtected) {
        throw "Protected Google provider configuration is incomplete."
    }
    $clientSecret = Unprotect-Secret -ProtectedValue $config.google.clientSecretProtected
    try {
        if ($config.google.clientId -notmatch "^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$") {
            throw "Protected Google provider configuration contains an invalid client ID."
        }
        if ($clientSecret -notmatch "^[A-Za-z0-9_-]{16,128}$") {
            throw "Protected Google provider configuration contains an invalid client secret."
        }
        $environment.GOOGLE_CLIENT_ID = [string]$config.google.clientId
        $environment.GOOGLE_CLIENT_SECRET = $clientSecret
        $desktopRedirectBaseUrl = if ($config.google.desktopRedirectBaseUrl) {
            [string]$config.google.desktopRedirectBaseUrl
        } else {
            "http://127.0.0.1:8768"
        }
        try {
            $redirectUri = [Uri]$desktopRedirectBaseUrl
        } catch {
            throw "Protected Google provider configuration contains an invalid desktop redirect origin."
        }
        if (
            $redirectUri.Scheme -ne "http" -or
            $redirectUri.Host -notin "127.0.0.1", "localhost", "::1" -or
            $redirectUri.IsDefaultPort -or
            $redirectUri.AbsolutePath -ne "/" -or
            $redirectUri.Query -or
            $redirectUri.Fragment -or
            $redirectUri.UserInfo
        ) {
            throw "Protected Google provider configuration contains an invalid desktop redirect origin."
        }
        $environment.OAUTH_REDIRECT_BASE_URL = $redirectUri.GetLeftPart([UriPartial]::Authority)
    } finally {
        $clientSecret = $null
    }
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
    if ($config.outboundEmail.port -lt 1 -or $config.outboundEmail.port -gt 65535) {
        throw "Protected outbound-email configuration contains an invalid port."
    }
    $smtpPassword = Unprotect-Secret -ProtectedValue $config.outboundEmail.passwordProtected
    try {
        $environment.EMAIL_PROVIDER = "smtp"
        $environment.SMTP_HOST = [string]$config.outboundEmail.host
        $environment.SMTP_PORT = [string]$config.outboundEmail.port
        $environment.SMTP_USER = [string]$config.outboundEmail.user
        $environment.SMTP_PASS = $smtpPassword
        $environment.SMTP_FROM = [string]$config.outboundEmail.from
        $environment.SMTP_STARTTLS = if ($config.outboundEmail.startTls) { "true" } else { "false" }
    } finally {
        $smtpPassword = $null
    }
}

$environment | ConvertTo-Json -Compress
