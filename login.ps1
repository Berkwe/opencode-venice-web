# Windows manual sign-in. Secrets travel over stdin, never command-line arguments.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 22 or newer, then open a new PowerShell window.'
}

Write-Host 'Sign in at https://venice.ai in your browser.'
Write-Host 'In DevTools (F12), Application > Cookies, copy __client from https://clerk.venice.ai.'
$defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
Write-Host 'Copy the User-Agent from the same browser (Console: navigator.userAgent), or leave blank to skip.'
Write-Host "Default User-Agent: $defaultUserAgent"
$secret = Read-Host 'Paste the __client value or __client=value (hidden)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
$previousEncoding = $OutputEncoding
try {
    $cookie = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $userAgent = Read-Host 'Paste the browser User-Agent (leave blank to skip and use the default)'
    if ([string]::IsNullOrWhiteSpace($userAgent)) { $userAgent = $defaultUserAgent }
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    @{ cookie = $cookie; userAgent = $userAgent } | ConvertTo-Json -Compress |
        & node (Join-Path $PSScriptRoot 'src/login.mjs') --stdin
    if ($LASTEXITCODE -ne 0) { throw 'Sign-in failed. Copy a fresh cookie from the signed-in browser and retry.' }
} finally {
    $OutputEncoding = $previousEncoding
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $cookie = $null
    $secret.Dispose()
}
