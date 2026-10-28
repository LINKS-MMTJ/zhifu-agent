# ZhiFu Agent one-click launcher (ASCII only, robust: launches node.exe directly)
# Usage: powershell -ExecutionPolicy Bypass -File .\start.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1) Locate Node: prefer portable, then system
$portable = 'C:\Users\ZhuanZ1\nodejs\current'
$nodeExe = $null
if (Test-Path "$portable\node.exe") { $nodeExe = "$portable\node.exe" }
elseif (Get-Command node -ErrorAction SilentlyContinue) { $nodeExe = (Get-Command node).Source }
if (-not $nodeExe) { Write-Host "Node.js not found. Install Node 18+ and retry." -ForegroundColor Red; exit 1 }
Write-Host "[1/4] Node: $nodeExe ($(& $nodeExe --version))" -ForegroundColor Cyan

# 2) Install deps if missing
Write-Host "[2/4] Checking dependencies..." -ForegroundColor Cyan
$npmCli = Join-Path (Split-Path $nodeExe) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path "$root\server\node_modules")) {
    Write-Host "  Installing server deps..."; Push-Location "$root\server"; & $nodeExe $npmCli install --registry=https://registry.npmmirror.com; Pop-Location
}
if (-not (Test-Path "$root\web\node_modules")) {
    Write-Host "  Installing web deps..."; Push-Location "$root\web"; & $nodeExe $npmCli install --registry=https://registry.npmmirror.com; Pop-Location
}

# 3) Generate PWA icons if missing
if (-not (Test-Path "$root\web\public\icon-192.png")) {
    Write-Host "[3/4] Generating PWA icons..." -ForegroundColor Cyan
    & $nodeExe "$root\web\scripts\make-icons.js"
} else { Write-Host "[3/4] Icons exist, skip" -ForegroundColor Cyan }

# 4) Launch node processes directly (hidden, with logs) - avoids PS execution-policy & quoting issues
# --env-file-if-exists=.env : 存在 .env 时自动加载 DEEPSEEK_API_KEY，缺失也不报错
Write-Host "[4/4] Starting services..." -ForegroundColor Cyan
Start-Process -FilePath $nodeExe -ArgumentList "--env-file-if-exists=.env", "src/index.js" -WorkingDirectory "$root\server" -WindowStyle Hidden -RedirectStandardOutput "$root\server\server.log" -RedirectStandardError "$root\server\server.err.log"
Start-Sleep 2
Start-Process -FilePath $nodeExe -ArgumentList "node_modules/vite/bin/vite.js --port 5173 --strictPort" -WorkingDirectory "$root\web" -WindowStyle Hidden -RedirectStandardOutput "$root\web\web.log" -RedirectStandardError "$root\web\web.err.log"

Start-Sleep 6
$be = try { (Invoke-WebRequest -Uri "http://localhost:4000/api/health" -UseBasicParsing).StatusCode } catch { "DOWN" }
$fe = try { (Invoke-WebRequest -Uri "http://localhost:5173/" -UseBasicParsing).StatusCode } catch { "DOWN" }
Write-Host ""
Write-Host "Backend  http://localhost:4000 -> $be" -ForegroundColor Green
Write-Host "Frontend http://localhost:5173 -> $fe" -ForegroundColor Green
Write-Host "Logs: server\server.log , web\web.log" -ForegroundColor Cyan
if ($fe -eq 200) { Start-Process "http://localhost:5173" }
