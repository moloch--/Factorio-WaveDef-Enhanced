# Factorio Wave Defense Enhanced

A fresh mod development scaffold for **Factorio 2.0**, configured and tested with
**Factorio 2.0.77 on Windows**. Wave gameplay is not implemented yet.

The mod currently initializes persistent state and provides `/wde-status` to
confirm it is running. Source files live in `mod/`.

## Start developing

Open this repository folder in VS Code. The following commands run from the
repository root in PowerShell:

```powershell
# Prepare the isolated game profile and repository-local formatter.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 Setup

# Install editor extensions and regenerate completion data for the installed game.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-editor.ps1

# Check metadata, Lua 5.2 syntax, and formatting.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 Validate

# Create a map, reload it, and run 600 ticks in the actual Factorio engine.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 Test

# Open the game with the development mod enabled.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 Run
```

Setup has already been completed on this computer. A separate standalone Lua
interpreter is unnecessary: Factorio supplies the runtime. `-ExecutionPolicy
Bypass` applies only to the command being run and does not change your system
execution policy.

If Factorio lives elsewhere, run `Setup -FactorioPath
"D:\SteamLibrary\steamapps\common\Factorio\bin\x64\factorio.exe"` after the
script path. `FACTORIO_PATH` is also supported. The selected path is saved locally
in `.dev/local.json`. Rerun editor setup after changing the game installation.

## Edit and debug

- **Ctrl+Shift+B** runs validation. Formatting happens when saving Lua files.
- In the command palette, run **Factorio: Select Version** and select the
  configured Factorio 2.0.77 installation on first use.
- Press **F5** with **Factorio: Debug local mod (2.0)** selected. Create a freeplay
  game or load a development save, then enter `/wde-status` in the console.
- Set a breakpoint inside `commands.add_command` in `mod/control.lua`, then run
  `/wde-status` to exercise it. The Lua language server may ask once to trust its
  locally generated Factorio API plugin.
- Use **Terminal > Run Task** for Setup, Validate, Format, Smoke test, Package,
  or Play.

Installed tools:

| Tool | Version / purpose |
| --- | --- |
| Factorio Mod Tool Kit | **2.0.14**, pinned for the Factorio 2.0 debugger |
| Lua Language Server | Lua 5.2 completion, diagnostics, and navigation |
| StyLua extension | Format on save |
| StyLua CLI | **2.6.0**, downloaded locally with a checked SHA-256 hash |

Keep FMTK on **2.0.14** while targeting this game version. Its 2.1 line targets
Factorio's newer debugger. Extension recommendations cannot pin versions; use
`setup-editor.ps1` to reproduce the compatible installation. Lua completion data
comes from the installed game's `doc-html` API JSON files and stays untracked.

## Local game profile

`.dev/config.ini` redirects game writes to `.dev/user-data/`, and all launch
commands use `.dev/mods/`. Setup creates a Windows directory junction from
`.dev/mods/wave-defense-enhanced` to `mod/`, so Factorio reads your current source
directly. Directory junctions do not require enabling Windows Developer Mode.

The profile enables `base` and this mod. Setup restores that small mod list for
reproducible tests; add other mod dependencies deliberately when development
needs them. Your regular `%APPDATA%\Factorio` mods, saves, and settings are not
part of this profile. The starter does not require Space Age.

- Development saves: `.dev/user-data/saves/`
- Captured test output: `.dev/logs/`
- Latest successful test details: `.dev/last-test.json`
- Game log: `.dev/user-data/factorio-current.log`
- Machine-specific editor configuration: `.vscode/settings.json` (untracked)

Use a new game or reload a save after changing runtime Lua. Prototype changes
in `data.lua` require restarting the game. Smoke tests create uniquely named
saves and retain their logs; they do not exercise gameplay that has not yet
been implemented or verify interactive debugger breakpoints.

## Format and package

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 Format
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 Package
```

Packaging validates first, then writes
`dist/wave-defense-enhanced_0.1.0.zip` with the required mod folder inside it.
Only files from `mod/` are packaged. Rebuilding replaces that version's local
archive. Increment `mod/info.json` and add a `mod/changelog.txt` entry when
preparing a new version.

## Source layout

```text
mod/
  info.json              Identity, target game version, dependencies
  control.lua            Runtime events, persistent state, status command
  data.lua               Prototype-stage entry point
  locale/en/wave-defense-enhanced.cfg  English strings
  changelog.txt          Factorio-formatted change history
scripts/
  dev.ps1                Setup, checks, formatting, game tests, packaging, play
  setup-editor.ps1       Compatible extensions and game-specific Lua definitions
.vscode/                 Tasks, debugger configuration, extension recommendations
```

Use `storage` for persistent runtime state and keep simulation behavior
deterministic for multiplayer. Register runtime events and commands in
`control.lua`; add prototype definitions through `data.lua` and modules it
loads. The current scaffold preserves its state during configuration changes.

## Git

The local repository uses `main`. Generated profiles, saves, tools, API
definitions, and ZIPs are ignored. Commit identity is configured for this
repository only, using the authenticated GitHub account and its GitHub noreply
address. No remote repository has been created or configured.

Choose a license before publishing or accepting contributions. No license has
been selected for this new project yet.

## References

- [Factorio mod structure](https://lua-api.factorio.com/latest/auxiliary/mod-structure.html)
- [Factorio command-line options](https://wiki.factorio.com/Command_line_parameters)
- [FMTK 2.0.14 configuration](https://github.com/justarandomgeek/vscode-factoriomod-debug/blob/2.0.14/package.json)
- [FMTK Lua integration](https://github.com/justarandomgeek/vscode-factoriomod-debug/blob/2.0.14/doc/language-lua.md)
- [StyLua](https://github.com/JohnnyMorganz/StyLua)

The installed Factorio `doc-html/index.html` is the API reference matching your
game. Online `latest` documentation may describe a newer version.
