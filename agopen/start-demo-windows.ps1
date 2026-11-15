# Live demo on Windows WITHOUT AgOpenWeb: stand-in vehicles (agopen/mock-node.js) + the real coordinator
# and status page (agopen/live.js on http://localhost:5190). For UI work and rehearsals; the macOS
# launcher (start-demo.sh) with real AgOpenWeb copies is still the real demo.
#
#   agopen\start-demo-windows.cmd            start everything
#   agopen\start-demo-windows.cmd -Stop      stop everything
#   agopen\start-demo-windows.cmd -Speed 3   vehicles move 3x faster (quicker to see things happen)
param([switch]$Stop, [double]$Speed = 1, [string]$LiveArgs = '--fuel-scale 70')

$repo = Split-Path -Parent $PSScriptRoot

function Stop-All {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'agopen[\\/](mock-node|tractor-node|live)\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item "$repo\agopen\out\lock-*.json" -Force -ErrorAction SilentlyContinue
}
function Wait-Url($url, $tries = 40) {
  for ($k = 0; $k -lt $tries; $k++) {
    try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 1 | Out-Null; return $true } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}
function Open-Window($title, $command) {
  $cmd = "`$host.UI.RawUI.WindowTitle = '$title'; Set-Location '$repo'; $command"
  Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-Command', $cmd | Out-Null
}

if ($Stop) { Stop-All; Write-Host 'Everything stopped.'; exit 0 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node.js is not installed (https://nodejs.org).'; exit 1 }
if (-not (Test-Path "$repo\node_modules\ws")) { Write-Host 'Installing packages (first run only)...'; Push-Location $repo; npm.cmd install; Pop-Location }

Write-Host '1/4 Stopping anything left from an earlier run...'
Stop-All
Write-Host '2/4 Writing the farm (field outlines the coordinator reads)...'
Push-Location $repo; node agopen/build-farm.js | Out-Null; Pop-Location

Write-Host '3/4 Starting stand-in vehicles (T1, T2, T3, fuel truck) and the coordinator...'
$sp = if ($Speed -ne 1) { " --speed $Speed" } else { '' }
Open-Window 'Tractor T1 (mock)' "node agopen/mock-node.js T1 5175 --bay 0$sp"
Open-Window 'Tractor T2 (mock)' "node agopen/mock-node.js T2 5176 --bay 1$sp"
Open-Window 'Tractor T3 (mock)' "node agopen/mock-node.js T3 5177 --bay 2$sp"
Open-Window 'Fuel truck (mock)' "node agopen/mock-node.js FUEL 5178 --bay 3$sp"
foreach ($p in 6175, 6176, 6177, 6178) {
  if (-not (Wait-Url "http://127.0.0.1:$p/telemetry")) { Write-Host "Vehicle on port $p did not start; look at its window."; exit 1 }
}
Open-Window 'Fleet coordinator' "node agopen/live.js $LiveArgs"
if (-not (Wait-Url 'http://127.0.0.1:5190/state' 60)) { Write-Host 'The coordinator did not start; look at its window.'; exit 1 }

Write-Host '4/4 Opening http://localhost:5190/'
Start-Process 'http://localhost:5190/'
Write-Host ''
Write-Host 'Running. Type dead / stuck / ok in a tractor window to inject a fault.'
Write-Host 'Stop everything with:  agopen\start-demo-windows.cmd -Stop'
