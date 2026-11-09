param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$lab = '\\wsl.localhost\Ubuntu-24.04\home\sqz269\vllm-translation-lab'
$bridgePath = Join-Path $lab 'windows-bridge.cjs'
$pidPath = Join-Path $lab 'windows-bridge.pid'
$bridge = $null
if (Test-Path -LiteralPath $pidPath) {
    $bridgeId = [int](Get-Content -Raw -LiteralPath $pidPath).Trim()
    $bridge = Get-CimInstance Win32_Process -Filter "ProcessId = $bridgeId"
    if ($bridge -and ($bridge.Name -ne 'node.exe' -or -not $bridge.CommandLine.Contains($bridgePath))) {
        throw 'Recorded bridge PID belongs to another process; refusing to manage it.'
    }
}
if ($Stop) {
    if ($bridge) { Stop-Process -Id $bridge.ProcessId }
    if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath }
    wsl -d Ubuntu-24.04 -- python3 /home/sqz269/vllm-translation-lab/serverctl.py stop
    if ($LASTEXITCODE -ne 0) { throw 'Server shutdown failed; inspect the server controller output.' }
    return
}
if ($bridge) {
    try {
        $health = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 3 -UseBasicParsing
        if ($health.StatusCode -eq 200) {
            Write-Output 'Gemma is already running at http://127.0.0.1:8000/v1/chat/completions'
            return
        }
    } catch { }
}
# The controller refuses duplicate starts and validates its recorded process group.
wsl -d Ubuntu-24.04 -- python3 /home/sqz269/vllm-translation-lab/serverctl.py start --tag desktop
if (-not $bridge) {
    $nodePath = (Get-Command node).Source
    $proc = Start-Process -FilePath $nodePath -ArgumentList @($bridgePath) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $lab 'windows-bridge.log') -RedirectStandardError (Join-Path $lab 'windows-bridge-error.log') -PassThru
    $proc.Id | Set-Content -LiteralPath $pidPath
}
Write-Output 'Gemma endpoint: http://127.0.0.1:8000/v1/chat/completions'
Write-Output 'Model loading can take about a minute. Health: http://127.0.0.1:8000/health'