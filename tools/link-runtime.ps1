# ============================================================
#  造一份"别人电脑上那种原版安装"：Mineradio.exe + resources/app（上游原版）
#
#  运行时文件（exe/dll/pak…）用硬链接，同盘瞬间完成、不额外占 350MB；
#  resources/app 用 .fixture/stock-app（git archive 出来的上游原版）真复制一份 ——
#  这份要被安装器改写，绝不能是硬链接，否则改的是你正在用的那一份。
#
#  两个源目录都可以用环境变量改：
#    MINERADIO_RUNTIME_SRC  装好的 Mineradio 根目录（取运行时文件），默认 E:\Projects\mineradio
#    MINERADIO_DEV_REPO     上游源码仓库（取 .fixture 夹具），默认同一个
#  产物固定落在本仓库的 .live/Mineradio（README 的下一步就指这个路径）。
# ============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot            # tools/ 的上一级 = 仓库根
$src = if ($env:MINERADIO_RUNTIME_SRC) { $env:MINERADIO_RUNTIME_SRC } else { 'E:\Projects\mineradio' }
$dev = if ($env:MINERADIO_DEV_REPO) { $env:MINERADIO_DEV_REPO } else { $src }
$dst = Join-Path $root '.live\Mineradio'
$fixture = Join-Path $root '.fixture\stock-app'
$app = Join-Path $dst 'resources\app'

if (-not (Test-Path $src)) { throw "找不到运行时来源目录：$src（用 MINERADIO_RUNTIME_SRC 指过去）" }

# 夹具：没有就从上游基线提交取一份上游原版（和 tests 里同一套做法）
if (-not (Test-Path (Join-Path $fixture 'server.js'))) {
  if (-not (Test-Path (Join-Path $dev '.git'))) { throw "既没有 $fixture，也没有 git 仓库 $dev：先准备上游原版夹具" }
  New-Item -ItemType Directory -Force -Path $fixture | Out-Null
  bash -c "git -C `"$dev`" archive d43de56 | tar -x -C `"$fixture`""
  if (-not (Test-Path (Join-Path $fixture 'server.js'))) { throw '夹具解包失败' }
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dst 'resources') | Out-Null
# 运行时文件用硬链接：同盘瞬间完成，不额外占 350MB
Get-ChildItem -Path $src -File | Where-Object { $_.Name -match '\.(exe|dll|pak|dat|bin|json|ico)$' } | ForEach-Object {
  $link = Join-Path $dst $_.Name
  if (Test-Path $link) { Remove-Item $link -Force }
  New-Item -ItemType HardLink -Path $link -Target $_.FullName | Out-Null
}
$loc = Join-Path $dst 'locales'
if (Test-Path $loc) { cmd /c rmdir "$loc" | Out-Null }
if (Test-Path (Join-Path $src 'locales')) {
  New-Item -ItemType Junction -Path $loc -Target (Join-Path $src 'locales') | Out-Null
}

# 装过一次的痕迹要清干净，再放一份上游原版；这份是真副本，安装器改的是它
if (Test-Path $app) { Remove-Item $app -Recurse -Force }
Copy-Item -Path $fixture -Destination $app -Recurse -Force

Write-Output ("runtime files: " + (Get-ChildItem $dst -File).Count)
Write-Output ("app files: " + (Get-ChildItem $app -File -Recurse).Count)
Write-Output ("exe: " + (Test-Path (Join-Path $dst 'Mineradio.exe')))
Write-Output ("dst: " + $dst)
