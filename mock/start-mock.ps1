# Starts the mock server on 127.0.0.1:2222 and prints what to type in Add server.
# Creates an SSH key for it once, in mock\.ssh (git-ignored).
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$keyDir = Join-Path $here '.ssh'
$key = Join-Path $keyDir 'mock_ed25519'

if (-not (Test-Path $key)) {
    New-Item -ItemType Directory -Force $keyDir | Out-Null
    ssh-keygen -q -t ed25519 -N '""' -C 'log-analyzer-mock' -f $key
}

$env:MOCK_PUBLIC_KEY = (Get-Content "$key.pub" -Raw).Trim()
docker compose -f (Join-Path $here 'docker-compose.yml') up -d
if ($LASTEXITCODE -ne 0) { throw 'docker compose failed - is Docker Desktop running?' }

Write-Host ''
Write-Host 'Mock server running. In Log Analyzer -> + Add server:'
Write-Host '  User          mock'
Write-Host '  IP / host     127.0.0.1'
Write-Host '  Log directory /var/log/mock'
Write-Host '  Advanced -> SSH port 2222'
Write-Host "  Advanced -> Private key $key"
Write-Host ''
Write-Host 'Stop it with: docker compose -f mock\docker-compose.yml down -v'
