param(
  [string]$ReleaseDirectory = 'release',
  [string]$UpgradeDirectory = 'artifacts\upgrade-packages'
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot ('artifacts\installers-' + [Guid]::NewGuid())))
if (-not $testRoot.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installation test directory' }
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $ReleaseDirectory))
$upgradeRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $UpgradeDirectory))
foreach ($path in @($releaseRoot, $upgradeRoot)) {
  if (-not $path.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer packages must be within the workspace' }
}
function Installed-ShellGrid {
  foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -match '^ShellGrid(?:\s+v?\d.*)?$' }
  }
}
if (@(Installed-ShellGrid).Count) { throw 'An existing ShellGrid installation must not be replaced by verification' }
$shortcutPaths = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ShellGrid.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'ShellGrid.lnk')
)
foreach ($path in $shortcutPaths) {
  if (Test-Path -LiteralPath $path) { throw 'An existing ShellGrid shortcut must not be replaced by verification' }
}
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
$nextVersion = ([version]$version).Major.ToString() + '.' + ([version]$version).Minor + '.' + (([version]$version).Build + 1)
$oldExe = Join-Path $releaseRoot "ShellGrid-$version-x64-Setup.exe"
$oldMsi = Join-Path $releaseRoot "ShellGrid-$version-x64-Setup.msi"
$newExe = Join-Path $upgradeRoot "ShellGrid-$nextVersion-x64-Setup.exe"
$newMsi = Join-Path $upgradeRoot "ShellGrid-$nextVersion-x64-Setup.msi"
foreach ($path in @($oldExe, $oldMsi, $newExe, $newMsi)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing installer: $path" }
}
New-Item -ItemType Directory -Path $testRoot | Out-Null
$dataDirectory = Join-Path $env:LOCALAPPDATA 'ShellGrid'
$workspacePath = Join-Path $dataDirectory 'workspace.json'
$createdDataDirectory = -not (Test-Path -LiteralPath $dataDirectory)
$createdWorkspace = -not (Test-Path -LiteralPath $workspacePath)
if ($createdWorkspace) {
  [IO.File]::WriteAllText($workspacePath, '{"schemaVersion":1,"layout":{"type":"pane","paneId":"installer-fixture"},"panes":{"installer-fixture":{"cwd":"C:\\","shell":"pwsh.exe","args":["-NoLogo"]}}}', [Text.UTF8Encoding]::new($false))
}
$workspaceHash = (Get-FileHash -LiteralPath $workspacePath -Algorithm SHA256).Hash
$results = [Collections.Generic.List[string]]::new()
function Check-Data {
  if ((Get-FileHash -LiteralPath $workspacePath -Algorithm SHA256).Hash -ne $workspaceHash) { throw 'Installer changed workspace data' }
}
function Run-Installer([string]$Executable, [string[]]$Arguments) {
  # NSIS requires /D=... last and unquoted, even when the directory has spaces.
  # Keep simple switches unquoted; quote paths only where the receiving CLI allows it.
  $quoted = @($Arguments | ForEach-Object {
    if ($_ -match '^/D=' -or $_ -notmatch '[\s"]') { $_ }
    elseif ($_ -match '^([A-Z][A-Z0-9_]*)=(.*)$') { $Matches[1] + '="' + $Matches[2] + '"' }
    else { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
  })
  $process = Start-Process -FilePath $Executable -ArgumentList $quoted -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -notin @(0, 3010)) { throw "Installer failed with code $($process.ExitCode)" }
}
function Check-Installation([string]$Target, [string]$ExpectedVersion) {
  $targetPath = [IO.Path]::GetFullPath($Target)
  if (-not $targetPath.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Installation escaped the verified test directory' }
  foreach ($relative in @('ShellGrid.exe', 'resources\app.asar', 'resources\app.asar.unpacked\dist-electron\pty-host.cjs',
    'resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\conpty.node',
    'resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\conpty\conpty.dll',
    'resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\conpty\OpenConsole.exe',
    'resources\app.asar.unpacked\node_modules\node-pty\lib\worker\conoutSocketWorker.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Target $relative) -PathType Leaf)) { throw "Installed runtime file missing: $relative" }
  }
  $installed = @(Installed-ShellGrid)
  # MSI records Windows' fourth version component (for example 0.3.0.0).
  $matchesVersion = $installed.Count -eq 1 -and ([version]$installed[0].DisplayVersion).ToString(3) -eq ([version]$ExpectedVersion).ToString(3) -and ([version]$installed[0].DisplayVersion).Revision -le 0
  if (-not $matchesVersion) {
    throw ('Installed version/upgrade registry mismatch: expected ' + $ExpectedVersion + '; count ' + $installed.Count + '; versions ' + ($installed.DisplayVersion -join ','))
  }
  Check-Data
}
$activeUninstaller = $null
$activeMsi = $null
try {
  $exeTarget = Join-Path $testRoot 'exe-app'
  Run-Installer $oldExe @('/S', '/currentuser', "/D=$exeTarget")
  $activeUninstaller = Join-Path $exeTarget 'Uninstall ShellGrid.exe'
  Check-Installation $exeTarget $version
  $results.Add('NSIS fresh per-user install and Electron/node-pty runtime paths')
  Run-Installer $newExe @('/S', '/currentuser', "/D=$exeTarget")
  Check-Installation $exeTarget $nextVersion
  $results.Add('NSIS subsequent version upgrade preserves workspace')
  Run-Installer $activeUninstaller @('/S', '/currentuser')
  $activeUninstaller = $null
  Check-Data
  if (@(Installed-ShellGrid).Count) { throw 'NSIS uninstall left an installed product entry' }
  if (Test-Path -LiteralPath (Join-Path $exeTarget 'ShellGrid.exe')) { throw 'NSIS uninstall left the application installed' }
  $results.Add('NSIS uninstall preserves workspace')

  $msiTarget = Join-Path $testRoot 'msi-app'
  Run-Installer 'msiexec.exe' @('/i', $oldMsi, '/qn', '/norestart', 'ALLUSERS=2', 'MSIINSTALLPERUSER=1', "APPLICATIONFOLDER=$msiTarget")
  $activeMsi = $oldMsi
  Check-Installation $msiTarget $version
  $results.Add('MSI fresh per-user install and Electron/node-pty runtime paths')
  Run-Installer 'msiexec.exe' @('/i', $newMsi, '/qn', '/norestart', 'ALLUSERS=2', 'MSIINSTALLPERUSER=1', "APPLICATIONFOLDER=$msiTarget")
  $activeMsi = $newMsi
  Check-Installation $msiTarget $nextVersion
  $results.Add('MSI subsequent version upgrade preserves workspace')
  Run-Installer 'msiexec.exe' @('/x', $activeMsi, '/qn', '/norestart')
  $activeMsi = $null
  Check-Data
  if (@(Installed-ShellGrid).Count) { throw 'MSI uninstall left an installed product entry' }
  if (Test-Path -LiteralPath (Join-Path $msiTarget 'ShellGrid.exe')) { throw 'MSI uninstall left the application installed' }
  $results.Add('MSI uninstall preserves workspace')
  $report = @{ date = [DateTime]::UtcNow.ToString('o'); fromVersion = $version; toVersion = $nextVersion; passed = $results.ToArray() }
  $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $repoRoot 'artifacts\installer-verification.json') -Encoding utf8
  Write-Output 'PASS: EXE/MSI install, upgrade, uninstall and business data retention'
}
finally {
  # Remove only this verification's installation, never a pre-existing product.
  if ($activeUninstaller -and (Test-Path -LiteralPath $activeUninstaller)) { Run-Installer $activeUninstaller @('/S', '/currentuser') }
  if ($activeMsi) { Run-Installer 'msiexec.exe' @('/x', $activeMsi, '/qn', '/norestart') }
  # The seeded business files are deleted only when still identical to our bytes.
  if ($createdWorkspace -and (Test-Path -LiteralPath $workspacePath) -and (Get-FileHash -LiteralPath $workspacePath).Hash -eq $workspaceHash) { Remove-Item -LiteralPath $workspacePath }
  if ($createdDataDirectory -and -not @(Get-ChildItem -LiteralPath $dataDirectory -Force).Count) { Remove-Item -LiteralPath $dataDirectory }
}
