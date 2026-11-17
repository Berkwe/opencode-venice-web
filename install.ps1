# Configure a Windows checkout. No admin rights, WSL, npm dependencies or service.
[CmdletBinding()]
param(
    [switch]$Login,
    [switch]$Default,
    [switch]$Start,
    [ValidateRange(1, 65535)][int]$Port = $(if ($env:VENICE_WEB_PORT) { [int]$env:VENICE_WEB_PORT } else { 3456 })
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 22 or newer, then open a new PowerShell window.'
}
$major = & node -p 'parseInt(process.versions.node)'
if ($LASTEXITCODE -ne 0 -or [int]$major -lt 22) { throw 'Node.js 22 or newer is required.' }
$curl = if ($env:VENICE_WEB_CURL) { $env:VENICE_WEB_CURL } else { 'curl.exe' }
& $curl --version
if ($LASTEXITCODE -ne 0) { throw 'curl.exe is required. Install curl or set VENICE_WEB_CURL to its executable path.' }
$env:VENICE_WEB_PORT = [string]$Port
if ($Login) { & (Join-Path $PSScriptRoot 'login.ps1') }
$syncArgs = @((Join-Path $PSScriptRoot 'src/sync.mjs'))
if ($Default) { $syncArgs += '--default' }
& node @syncArgs
if ($LASTEXITCODE -ne 0) { throw 'Could not configure the OpenCode provider.' }
Write-Host 'Configured. Keep this checkout in place; it is the installation directory.'
Write-Host 'Sign in: .\login.ps1'
Write-Host "Start:   .\start.ps1 -Port $Port"
Write-Host 'Check:   node src/doctor.mjs'
if ($Start) { & (Join-Path $PSScriptRoot 'start.ps1') -Port $Port }
