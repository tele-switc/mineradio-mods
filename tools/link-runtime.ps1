$ErrorActionPreference = 'Stop'
$src = 'E:\Projects\mineradio'
$dst = 'E:\Projects\mineradio-mods\.live\Mineradio'
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
New-Item -ItemType Junction -Path $loc -Target (Join-Path $src 'locales') | Out-Null
Write-Output ("runtime files: " + (Get-ChildItem $dst -File).Count)
Write-Output ("exe: " + (Test-Path (Join-Path $dst 'Mineradio.exe')))
