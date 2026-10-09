# Runs only on the disposable Windows Actions runner, after release assets have
# been collected. Build a genuinely older fixture, install it, then upgrade with
# the exact MSI and NSIS packages that will be published.
$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$baseline = '0.0.1'
$assetDirectory = Join-Path (Get-Location) 'release-assets'
$msi = @(Get-ChildItem $assetDirectory -Filter '*.msi')
$nsis = @(Get-ChildItem $assetDirectory -Filter '*.exe')
if ($msi.Count -ne 1 -or $nsis.Count -ne 1) { throw 'Expected one MSI and one NSIS release installer.' }
$dataDirectory = Join-Path $env:APPDATA 'app.okfviewer.desktop'
New-Item -ItemType Directory -Force $dataDirectory | Out-Null
$preferences = Join-Path $dataDirectory 'upgrade-smoke-settings.json'
Set-Content -Path $preferences -Value '{"reviewerId":"upgrade-smoke","savedQuizHistory":"keep"}' -Encoding utf8
$settingsHash = (Get-FileHash $preferences).Hash
$installDirectory = Join-Path $env:RUNNER_TEMP 'okf-upgrade-smoke'
$baselineConfig = Join-Path $env:RUNNER_TEMP 'okf-upgrade-baseline.json'
$installer = New-Object -ComObject WindowsInstaller.Installer
$currentProduct = $null

function Get-MsiProperty($file, $property) {
    $database = $installer.OpenDatabase($file, 0)
    $view = $database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='$property'")
    $view.Execute()
    $record = $view.Fetch()
    if ($null -eq $record) { throw "Missing MSI property $property" }
    $value = $record.StringData(1)
    $view.Close()
    return $value
}

function Invoke-Msi($operation, $file) {
    $log = Join-Path $env:RUNNER_TEMP 'okf-upgrade-msi.log'
    $process = Start-Process msiexec.exe -ArgumentList @($operation, "`"$file`"", '/qn', '/norestart', '/l*v', "`"$log`"") -PassThru -Wait
    if ($process.ExitCode -notin @(0, 3010)) {
        Get-Content $log -Tail 50
        throw "MSI operation failed: $($process.ExitCode)"
    }
}

function Assert-DataPreserved {
    if ((Get-FileHash $preferences).Hash -ne $settingsHash) { throw 'The installer changed application data.' }
}

try {
    pnpm version:set $baseline
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure the older test build.' }
    # pnpm's Windows command shim strips quotes from inline JSON. Pass a file
    # so Tauri receives the same configuration through every shell.
    '{"bundle":{"createUpdaterArtifacts":false}}' | Set-Content -Path $baselineConfig -Encoding utf8NoBOM
    pnpm tauri build --bundles msi,nsis --ci --config $baselineConfig
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the older test installers.' }
    $oldMsi = @(Get-ChildItem target/release/bundle/msi -Filter '*.msi' | Where-Object { $_.Name.Contains("_${baseline}_") })
    $oldNsis = @(Get-ChildItem target/release/bundle/nsis -Filter '*.exe' | Where-Object { $_.Name.Contains("_${baseline}_") })
    if ($oldMsi.Count -ne 1 -or $oldNsis.Count -ne 1) { throw 'Older test installers were not produced.' }

    $oldProduct = Get-MsiProperty $oldMsi[0].FullName 'ProductCode'
    $currentProduct = Get-MsiProperty $msi[0].FullName 'ProductCode'
    if ((Get-MsiProperty $oldMsi[0].FullName 'UpgradeCode') -ne (Get-MsiProperty $msi[0].FullName 'UpgradeCode')) {
        throw 'MSI upgrade identity changed.'
    }
    Invoke-Msi '/i' $oldMsi[0].FullName
    if ($installer.ProductInfo($oldProduct, 'VersionString') -ne $baseline) { throw 'The older MSI version did not install.' }
    Invoke-Msi '/i' $msi[0].FullName
    if ($installer.ProductInfo($currentProduct, 'VersionString') -ne $version) { throw 'MSI did not upgrade to the release version.' }
    if ($installer.ProductState($oldProduct) -ne -1) { throw 'The older MSI product was left installed.' }
    Assert-DataPreserved
    Invoke-Msi '/x' $currentProduct
    $currentProduct = $null

    foreach ($step in @(@($oldNsis[0].FullName, $baseline), @($nsis[0].FullName, $version))) {
        $process = Start-Process $step[0] -ArgumentList "/S /D=$installDirectory" -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "NSIS installation failed: $($process.ExitCode)" }
        $executable = Join-Path $installDirectory 'okf-viewer.exe'
        $installed = (Get-Item $executable).VersionInfo.ProductVersion
        if ($installed -notlike "$($step[1])*") { throw "Expected NSIS version $($step[1]); got $installed" }
        Assert-DataPreserved
        Get-Process okf-viewer -ErrorAction SilentlyContinue | Stop-Process -Force
    }
    Write-Output "MSI and NSIS upgrade tests passed: $baseline -> $version; application data preserved."
} finally {
    Get-Process okf-viewer -ErrorAction SilentlyContinue | Stop-Process -Force
    if ($null -ne $currentProduct -and $installer.ProductState($currentProduct) -eq 5) { Invoke-Msi '/x' $currentProduct }
    if (Test-Path $installDirectory) {
        $uninstaller = Get-ChildItem $installDirectory -Filter '*uninstall*.exe' | Select-Object -First 1
        if ($null -ne $uninstaller) { Start-Process $uninstaller.FullName -ArgumentList '/S' -Wait }
    }
    pnpm version:set $version
    Remove-Item $baselineConfig -ErrorAction SilentlyContinue
}
