[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$localFile = Join-Path $repoRoot '.dev/local.json'
$fmtkId = 'justarandomgeek.factoriomod-debug'
$fmtkVersion = '2.0.14'

$codeCommand = Get-Command code.cmd -ErrorAction SilentlyContinue
$candidates = @(
    $(if ($codeCommand) { $codeCommand.Source }),
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd"
)
$codeCmd = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $codeCmd) { throw 'Visual Studio Code was not found. Install VS Code for Windows, then rerun scripts/setup-editor.ps1.' }
$codeExe = Join-Path (Split-Path -Parent (Split-Path -Parent $codeCmd)) 'Code.exe'
if (-not (Test-Path -LiteralPath $codeExe -PathType Leaf)) { throw "VS Code executable not found beside $codeCmd." }

function Invoke-Code([string[]]$Arguments) {
    # Piping waits for the Windows GUI executable used by code.cmd.
    $output = & $script:codeCmd @Arguments | Out-String
    if ($LASTEXITCODE -ne 0) { throw "VS Code CLI failed (exit $LASTEXITCODE).`n$output" }
    return $output.Trim()
}

if (-not (Test-Path -LiteralPath $localFile)) {
    & (Join-Path $PSScriptRoot 'dev.ps1') Setup
}
$local = Get-Content -LiteralPath $localFile -Raw | ConvertFrom-Json
$installRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $local.factorioPath))
$runtimeDocs = Join-Path $installRoot 'doc-html/runtime-api.json'
$prototypeDocs = Join-Path $installRoot 'doc-html/prototype-api.json'
foreach ($doc in @($runtimeDocs, $prototypeDocs)) {
    if (-not (Test-Path -LiteralPath $doc -PathType Leaf)) { throw "Factorio API documentation is missing: $doc" }
}

$installed = (Invoke-Code @('--list-extensions', '--show-versions')) -split '\r?\n'
# Explicit versions also pin extensions, preventing an incompatible FMTK 2.1 upgrade.
Write-Host "Ensuring Factorio Modding Tool Kit $fmtkVersion is pinned..."
Write-Host (Invoke-Code @('--install-extension', "$fmtkId@$fmtkVersion"))
foreach ($extension in @('sumneko.lua', 'JohnnyMorganz.stylua')) {
    if ($installed -match ('^' + [regex]::Escape($extension) + '@')) {
        Write-Host "$extension is already installed."
    } else {
        Write-Host (Invoke-Code @('--install-extension', $extension))
    }
}
$verified = (Invoke-Code @('--list-extensions', '--show-versions')) -split '\r?\n'
if ($verified -notcontains "$fmtkId@$fmtkVersion") { throw "FMTK $fmtkVersion installation could not be verified." }
foreach ($extension in @('sumneko.lua', 'JohnnyMorganz.stylua')) {
    if (-not ($verified -match ('^' + [regex]::Escape($extension) + '@'))) { throw "$extension installation could not be verified." }
}
$extensionPath = Invoke-Code @('--locate-extension', $fmtkId)
$fmtkCli = Join-Path $extensionPath 'dist/fmtk-cli.js'
if (-not (Test-Path -LiteralPath $fmtkCli -PathType Leaf)) { throw "FMTK CLI is missing: $fmtkCli" }

$oldElectronMode = $env:ELECTRON_RUN_AS_NODE
$oldVsCodeDev = $env:VSCODE_DEV
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $env:VSCODE_DEV = $null
    $docsOutput = & $codeExe $fmtkCli luals-addon -d $runtimeDocs -p $prototypeDocs (Join-Path $repoRoot '.vscode/factorio') | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Factorio API generation failed (exit $LASTEXITCODE).`n$docsOutput" }
    Write-Host $docsOutput.Trim()
} finally {
    $env:ELECTRON_RUN_AS_NODE = $oldElectronMode
    $env:VSCODE_DEV = $oldVsCodeDev
}
$bundle = Get-Content -LiteralPath (Join-Path $repoRoot '.vscode/factorio/factorio/config.json') -Raw | ConvertFrom-Json
if ($bundle.factorioVersion -ne $local.version -or $bundle.bundleVersion -ne $fmtkVersion) {
    throw 'Generated API definitions do not match the configured Factorio and FMTK versions.'
}
Write-Host 'Editor setup complete. Open the repository in VS Code and select Factorio: Select Version before the first debug session.'
