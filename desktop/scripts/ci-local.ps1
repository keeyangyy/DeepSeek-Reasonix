# 本地 CI 门：合并/push 前跑一遍，覆盖云端关键检查
# 覆盖：repolint / gofmt / go build / 前端 typecheck / test:typecheck / eslint / bundle 预算
# （test:typecheck 与 bundle 预算曾三度致 CI 红，本地先拦）
# 用法：pwsh -File desktop/scripts/ci-local.ps1   （-Fast 跳过 eslint/bundle/测试；-Full 跑全套测试）
param([switch]$Fast, [switch]$Full)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$failed = @()

function Invoke-Step($name, [scriptblock]$body, [string]$dir) {
  Write-Host ""
  Write-Host ("=== " + $name + " ===") -ForegroundColor Cyan
  $prev = Get-Location
  if ($dir) { Set-Location $dir }
  try { & $body } catch { Write-Host ("  异常: " + $_.Exception.Message) }
  $code = $LASTEXITCODE
  if ($code -ne 0) { $script:failed += $name; Write-Host ("  X " + $name) -ForegroundColor Red } else { Write-Host ("  OK " + $name) -ForegroundColor Green }
  Set-Location $prev
}

# 改动文件：优先与远端主线比；在 main-v2 上则退化为最近提交
$changed = @(git diff --name-only origin/main-v2...HEAD 2>$null)
if ($changed.Count -eq 0) { $changed = @(git diff --name-only HEAD~1 2>$null) }
$changedGo = @($changed | Where-Object { $_ -like "*.go" })
$changedFe = @($changed | Where-Object { $_ -like "desktop/frontend/*" } | ForEach-Object { $_ -replace "^desktop/frontend/", "" })

Invoke-Step "gofmt（改动 Go）" {
  if ($changedGo.Count -gt 0) { gofmt -l $changedGo } else { $global:LASTEXITCODE = 0; Write-Host "  无 Go 改动" }
}
Invoke-Step "repolint" { go run ./tools/repolint }
Invoke-Step "go build ./..." { go build ./... }
Invoke-Step "前端 typecheck" { pnpm typecheck } "desktop/frontend"
Invoke-Step "前端 test:typecheck" { pnpm test:typecheck } "desktop/frontend"
if (-not $Fast) {
  # 测试执行：CI 的 desktop-frontend 会跑全套；默认跑受影响套件（transcript/
  # dedup/投影），--Full 跑全套 pnpm test——避免"只有 CI 能发现"的一轮轮循环。
  Invoke-Step "前端测试（受影响套件；-Full 跑全套）" {
    if ($Full) {
      pnpm test
    } else {
      node --import tsx src/__tests__/transcript-dedup-regression.test.ts src/__tests__/turn-event-projection-reset.test.ts src/__tests__/tab-switch-hydration.test.tsx src/__tests__/hydrate-history-apply.test.ts src/__tests__/replay-cursor-clamp.test.ts
      if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 1 }
    }
  } "desktop/frontend"
}
if (-not $Fast) {
  Invoke-Step "eslint（改动前端）" {
    if ($changedFe.Count -gt 0) {
      foreach ($f in $changedFe) {
        pnpm exec eslint $f
        if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 1; break }
      }
    } else { $global:LASTEXITCODE = 0; Write-Host "  无前端改动" }
  } "desktop/frontend"
  Invoke-Step "bundle 预算" { node scripts/check-bundle-budget.mjs } "desktop/frontend"
}

Write-Host ""
if ($failed.Count -gt 0) { Write-Host ("本地 CI 失败: " + ($failed -join ", ")) -ForegroundColor Red; exit 1 }
Write-Host "本地 CI 全绿" -ForegroundColor Green