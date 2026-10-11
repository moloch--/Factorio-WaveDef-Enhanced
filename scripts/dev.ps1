[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('Setup', 'Validate', 'Format', 'Test', 'TestWaveDefense', 'Package', 'Run', 'RunWaveDefense')]
    [string]$Action = 'Validate',
    [string]$FactorioPath,
    [ValidateRange(1, 1000000)]
    [int]$Ticks = 600
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$modRoot = Join-Path $repoRoot 'mod'
$devRoot = Join-Path $repoRoot '.dev'
$toolsRoot = Join-Path $repoRoot '.tools'
$configFile = Join-Path $devRoot 'config.ini'
$localFile = Join-Path $devRoot 'local.json'
$styluaVersion = '2.6.0'
$styluaHash = 'FD13B4014E3B779C244BBC03F2C282E357F15BC526DE6A6FA5ECBC447538313C'
$styluaExe = Join-Path $toolsRoot "stylua-$styluaVersion\stylua.exe"
$info = Get-Content -LiteralPath (Join-Path $modRoot 'info.json') -Raw | ConvertFrom-Json

function Write-Utf8([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, $Content.Replace("`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding($false)))
}

function Resolve-Factorio {
    $candidates = @()
    if ($FactorioPath) {
        $candidates = @($FactorioPath)
    } elseif ($env:FACTORIO_PATH) {
        $candidates = @($env:FACTORIO_PATH)
    } else {
        if (Test-Path -LiteralPath $localFile) {
            $saved = Get-Content -LiteralPath $localFile -Raw | ConvertFrom-Json
            $candidates += $saved.factorioPath
        }
        $candidates += "${env:ProgramFiles(x86)}\Steam\steamapps\common\Factorio\bin\x64\factorio.exe"
        $candidates += "$env:ProgramFiles\Factorio\bin\x64\factorio.exe"
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'Factorio not found. Run Setup -FactorioPath "D:\SteamLibrary\steamapps\common\Factorio\bin\x64\factorio.exe".'
}

function Ensure-StyLua {
    if (Test-Path -LiteralPath $styluaExe) { return }
    $downloadDir = Join-Path $toolsRoot 'downloads'
    New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
    $archive = Join-Path $downloadDir "stylua-$styluaVersion.zip"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host "Installing repository-local StyLua $styluaVersion..."
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/JohnnyMorganz/StyLua/releases/download/v$styluaVersion/stylua-windows-x86_64.zip" -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $styluaHash) {
        throw 'StyLua download failed its SHA-256 verification.'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath (Split-Path -Parent $styluaExe) -Force
}

function Invoke-Factorio([string[]]$Arguments, [string]$LogName) {
    # Use Process directly: PS 5.1 Start-Process can lose a fast GUI process's exit code.
    $stdout = Join-Path $devRoot "logs/$LogName.stdout.log"
    $stderr = Join-Path $devRoot "logs/$LogName.stderr.log"
    $quoted = foreach ($arg in $Arguments) {
        if ($arg.Contains('"')) { throw 'A Factorio argument contains an unsupported quote.' }
        '"' + $arg + '"'
    }
    $process = New-Object Diagnostics.Process
    $process.StartInfo.FileName = $script:factorioExe
    $process.StartInfo.Arguments = $quoted -join ' '
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    try {
        [void]$process.Start()
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        $finished = $process.WaitForExit(180000)
        if (-not $finished) { $process.Kill() }
        $process.WaitForExit()
        $outText = $outTask.GetAwaiter().GetResult()
        $errText = $errTask.GetAwaiter().GetResult()
        Write-Utf8 $stdout $outText
        Write-Utf8 $stderr $errText
        if (-not $finished) { throw "Factorio timed out after 180 seconds. See $stdout" }
        $output = $outText + $errText
        if ($process.ExitCode -ne 0) { throw "Factorio failed (exit $($process.ExitCode)).`n$output" }
    } finally { $process.Dispose() }
    return $output
}

function Ensure-Profile {
    $script:factorioExe = Resolve-Factorio
    foreach ($dir in @($devRoot, (Join-Path $devRoot 'mods'), (Join-Path $devRoot 'user-data'), (Join-Path $devRoot 'user-data/saves'), (Join-Path $devRoot 'logs'))) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $versionOutput = Invoke-Factorio -Arguments @('--version') -LogName 'version'
    if ($versionOutput -notmatch 'Version: (\d+\.\d+\.\d+)') { throw 'Could not determine Factorio version.' }
    $script:gameVersion = $Matches[1]
    if (-not $script:gameVersion.StartsWith($info.factorio_version + '.')) {
        throw "Installed Factorio $script:gameVersion does not match mod target $($info.factorio_version)."
    }
    $installRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $script:factorioExe))
    $dataPath = (Join-Path $installRoot 'data').Replace('\', '/')
    $writePath = (Join-Path $devRoot 'user-data').Replace('\', '/')
    if (Test-Path -LiteralPath $configFile) {
        $config = Get-Content -LiteralPath $configFile -Raw
        $config = [regex]::Replace($config, '(?m)^read-data=.*$', "read-data=$dataPath")
        $config = [regex]::Replace($config, '(?m)^write-data=.*$', "write-data=$writePath")
        Write-Utf8 $configFile $config.TrimEnd()
    } else {
        Write-Utf8 $configFile "[path]`nread-data=$dataPath`nwrite-data=$writePath"
    }
    Write-Utf8 $localFile (@{factorioPath = $script:factorioExe; version = $script:gameVersion} | ConvertTo-Json)
    $link = Join-Path $devRoot "mods/$($info.name)"
    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force
        if ($item.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath([string]$item.Target) -ne [IO.Path]::GetFullPath($modRoot)) {
            throw "Development mod path already exists and is not our junction: $link"
        }
    } else {
        New-Item -ItemType Junction -Path $link -Target $modRoot | Out-Null
    }
    # Only this repository's isolated mod profile is managed here.
    $mods = @{mods = @(@{name = 'base'; enabled = $true}, @{name = $info.name; enabled = $true}, @{name = 'space-age'; enabled = $false}, @{name = 'quality'; enabled = $false}, @{name = 'elevated-rails'; enabled = $false})}
    Write-Utf8 (Join-Path $devRoot 'mods/mod-list.json') ($mods | ConvertTo-Json -Depth 5)
    $editorFile = Join-Path $repoRoot '.vscode/settings.json'
    if (-not (Test-Path -LiteralPath $editorFile)) {
        $editor = [ordered]@{
            'factorio.versions' = @(@{name = "Factorio $script:gameVersion"; factorioPath = $script:factorioExe; configPath = $configFile})
            'factorio.docs.generateDocs' = $false
            'Lua.runtime.version' = 'Lua 5.2'
            'Lua.runtime.path' = @('?.lua', 'mod/?.lua')
            'Lua.runtime.plugin' = '.vscode/factorio/factorio/plugin.lua'
            'Lua.runtime.builtin' = @{io = 'disable'; os = 'disable'; coroutine = 'disable'; package = 'disable'; math = 'disable'; debug = 'disable'}
            'Lua.workspace.checkThirdParty' = $false
            'Lua.workspace.library' = @('.vscode/factorio/factorio/library')
            'Lua.diagnostics.globals' = @('__DebugAdapter', '__Profiler')
            'Lua.diagnostics.disable' = @('lowercase-global')
            'Lua.language.fixIndent' = $false
            'Lua.format.enable' = $false
            'Lua.telemetry.enable' = $false
            '[lua]' = @{'editor.defaultFormatter' = 'JohnnyMorganz.stylua'; 'editor.formatOnSave' = $true}
            'stylua.styluaPath' = $styluaExe
            'files.exclude' = @{'.dev' = $true; '.tools' = $true}
            'search.exclude' = @{'.dev/**' = $true; '.tools/**' = $true; 'dist/**' = $true; '.vscode/factorio/**' = $true}
            'files.watcherExclude' = @{'.dev/**' = $true; '.tools/**' = $true}
        }
        Write-Utf8 $editorFile ($editor | ConvertTo-Json -Depth 8)
    } else {
        $editor = Get-Content -LiteralPath $editorFile -Raw | ConvertFrom-Json
        $editor | Add-Member -NotePropertyName 'factorio.versions' -NotePropertyValue @(@{name = "Factorio $script:gameVersion"; factorioPath = $script:factorioExe; configPath = $configFile}) -Force
        $editor | Add-Member -NotePropertyName 'stylua.styluaPath' -NotePropertyValue $styluaExe -Force
        Write-Utf8 $editorFile ($editor | ConvertTo-Json -Depth 8)
    }
    Write-Host "Factorio $script:gameVersion | development profile: $devRoot"
}

function Validate-Mod {
    foreach ($field in @('name', 'version', 'title', 'author', 'factorio_version')) {
        if (-not $info.PSObject.Properties[$field] -or -not $info.$field) { throw "info.json is missing $field." }
    }
    if ($info.name -notmatch '^[A-Za-z0-9_-]{4,49}$') { throw 'Use a mod name containing 4-49 letters, digits, underscores or hyphens.' }
    if ($info.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must be number.number.number.' }
    if (@($info.version.Split('.') | Where-Object { [long]$_ -gt 65535 }).Count -gt 0) { throw 'Each version component must be <= 65535.' }
    if ($info.factorio_version -ne '2.0') { throw 'This development scaffold targets Factorio 2.0.' }
    Ensure-StyLua
    & $styluaExe --check --config-path (Join-Path $repoRoot '.stylua.toml') $modRoot
    if ($LASTEXITCODE -ne 0) { throw 'Lua syntax/format check failed. Run scripts/dev.ps1 Format.' }
    Write-Host 'Mod metadata and Lua 5.2 syntax/format checks passed.'
}

switch ($Action) {
    'Setup' {
        Ensure-Profile
        Ensure-StyLua
        Write-Host 'Setup complete. Open this folder in VS Code. See README.md for the pinned debugger extension.'
    }
    'Validate' { Validate-Mod }
    'Format' {
        Ensure-StyLua
        & $styluaExe --config-path (Join-Path $repoRoot '.stylua.toml') $modRoot
        if ($LASTEXITCODE -ne 0) { throw 'StyLua failed.' }
    }
    'Test' {
        Validate-Mod
        Ensure-Profile
        $testId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $save = Join-Path $devRoot "user-data/saves/smoke-$testId.zip"
        $common = @('--config', $configFile, '--mod-directory', (Join-Path $devRoot 'mods'))
        $created = Invoke-Factorio -Arguments ($common + @('--create', $save, '--map-gen-seed', '12345')) -LogName "create-$testId"
        if (-not (Test-Path -LiteralPath $save)) { throw 'Factorio did not produce a test save.' }
        if ($created -notmatch '\[wave-defense-enhanced\] initialized') { throw 'The mod initialization marker is missing from the game log.' }
        $benchmark = Invoke-Factorio -Arguments ($common + @('--benchmark', $save, '--benchmark-ticks', [string]$Ticks, '--benchmark-runs', '1')) -LogName "benchmark-$testId"
        if ($benchmark -notmatch 'Performed \d+ updates') { throw 'Factorio did not report completing the benchmark.' }
        Write-Utf8 (Join-Path $devRoot 'last-test.json') (@{factorioVersion = $script:gameVersion; ticks = $Ticks; save = $save; timestamp = (Get-Date).ToString('o')} | ConvertTo-Json)
        Write-Host "PASS: created a map, initialized the mod, reloaded it and ran $Ticks ticks."
        Write-Host "Save: $save"
        Write-Host "Logs: $(Join-Path $devRoot 'logs')"
    }
    'Package' {
        Validate-Mod
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $dist = Join-Path $repoRoot 'dist'
        New-Item -ItemType Directory -Path $dist -Force | Out-Null
        $baseName = "$($info.name)_$($info.version)"
        $archivePath = Join-Path $dist "$baseName.zip"
        # dist contains generated local build artifacts; rebuilding replaces this version.
        $stream = [IO.File]::Open($archivePath, [IO.FileMode]::Create)
        $zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($file in Get-ChildItem -LiteralPath $modRoot -File -Recurse) {
                $relative = $file.FullName.Substring($modRoot.Length + 1).Replace('\', '/')
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, "$baseName/$relative", [IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
        } finally { $zip.Dispose(); $stream.Dispose() }
        Write-Host "Package: $archivePath"
    }
    'Run' {
        Ensure-Profile
        # Run is an explicit request to open the interactive game.
        Start-Process -FilePath $script:factorioExe -ArgumentList "--config `"$configFile`" --mod-directory `"$(Join-Path $devRoot 'mods')`""
    }
    'RunWaveDefense' {
        Ensure-Profile
        Start-Process -FilePath $script:factorioExe -ArgumentList "--config `"$configFile`" --mod-directory `"$(Join-Path $devRoot 'mods')`" --load-scenario base/wave-defense"
    }
    'TestWaveDefense' {
        Validate-Mod
        Ensure-Profile
        $node = Get-Command node -ErrorAction SilentlyContinue
        $oldElectronMode = $env:ELECTRON_RUN_AS_NODE
        try {
            if ($node) {
                $runtime = $node.Source
            } else {
                # VS Code includes a suitable Node runtime, also used by setup-editor.ps1.
                $runtime = @("$env:ProgramFiles\Microsoft VS Code\Code.exe", "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
                if (-not $runtime) { throw 'Install Node.js 22+ or VS Code to run the scenario tests.' }
                $env:ELECTRON_RUN_AS_NODE = '1'
            }
            & $runtime (Join-Path $PSScriptRoot 'test-wave-defense.mjs') | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'Wave Defense integration tests failed. See .dev/wave-tests for logs.' }
        } finally { $env:ELECTRON_RUN_AS_NODE = $oldElectronMode }
    }
}
