# Foreground proxy; Ctrl+C stops it. Paths are relative to this script, not the shell.
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = $(if ($env:VENICE_WEB_PORT) { [int]$env:VENICE_WEB_PORT } else { 3456 }),
    [string]$ListenAddress = $(if ($env:VENICE_WEB_HOST) { $env:VENICE_WEB_HOST } else { '127.0.0.1' })
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 22 or newer, then open a new PowerShell window.'
}
$env:VENICE_WEB_PORT = [string]$Port
$env:VENICE_WEB_HOST = $ListenAddress
& node (Join-Path $PSScriptRoot 'src/proxy.mjs')
exit $LASTEXITCODE
