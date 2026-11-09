param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$bridgePath = Join-Path $PSScriptRoot 'vertex_bridge.py'
$stateDir = Join-Path $env:LOCALAPPDATA 'LMTranslate'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$pidPath = Join-Path $stateDir 'vertex-bridge.pid'
$bridge = $null
if (Test-Path -LiteralPath $pidPath) {
    $bridgeId = [int](Get-Content -Raw -LiteralPath $pidPath).Trim()
    $bridge = Get-CimInstance Win32_Process -Filter "ProcessId = $bridgeId"
    if ($bridge -and ($bridge.Name -notmatch '^python(w|[0-9.]*)?\.exe$' -or -not $bridge.CommandLine.Contains($bridgePath))) {
        throw 'Recorded PID belongs to another process; refusing to manage it.'
    }
}
if ($Stop) {
    if ($bridge) { Stop-Process -Id $bridge.ProcessId }
    if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath }
    return
}
if (-not $bridge) {
    $pythonPath = (Get-Command python).Source
    $cachePath = Join-Path $stateDir 'python-cache'
    $process = Start-Process -FilePath $pythonPath -ArgumentList @('-X', ('"pycache_prefix=' + $cachePath + '"'), ('"' + $bridgePath + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stateDir 'vertex-bridge.log') -RedirectStandardError (Join-Path $stateDir 'vertex-bridge-error.log')
    $process.Id | Set-Content -LiteralPath $pidPath
}
$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:8001/health' -TimeoutSec 2
        if ($health.service -eq 'lm-translate-vertex') { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
}
if (-not $ready) { throw "Bridge failed to start. Check $stateDir\vertex-bridge-error.log" }
Write-Output 'Vertex bridge ready: http://127.0.0.1:8001/v1/chat/completions'
Write-Output 'Reload the extension, select a Gemini Vertex preset, and Save.'
