# Nimbus music helper, for Windows: sets the helper up, or brings it up to date, and starts it. (On
# macOS and Linux, install.sh does the same.) Run the line /musichelper gives you, in PowerShell,
# Windows Terminal or Command Prompt:
#
#   powershell -c "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ChaseFranz/discord-bot/main/helper/install.ps1))) <your code>"
#
# and to start the helper again later, the same line without the code.
#
# What it does, in .nimbus-music-helper in your user folder (the helper's own folder):
#   1. It uses your Node.js if it is version 22 or newer. If not, it downloads one fixed version
#      from nodejs.org the first time, and checks it against the SHA-256 written below.
#   2. It downloads the latest helper, one file, from GitHub, so starting it this way also keeps
#      it up to date.
#   3. It starts the helper, which fetches yt-dlp and ffmpeg itself (see README.md).
# It needs no admin rights and changes nothing outside that folder: nothing is added to your PATH,
# and nothing is set to start by itself. It runs in Windows PowerShell 5.1, which comes with
# Windows, and in PowerShell 7.

param([string]$Code)

# In a block of its own, so that nothing it sets is left behind in your PowerShell.
& {
  param([string]$Code)

  $NodeVersion = '26.13.1'
  $NodeDownloads = "https://nodejs.org/dist/v$NodeVersion"
  # The SHA-256 of each Node.js download, from the SHASUMS256.txt published with it. To move to a
  # newer Node.js, change $NodeVersion and these together, and the same in install.sh.
  $NodeSha256 = @{
    'x64'   = 'e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7'
    'arm64' = '181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97'
  }
  $HelperDownload = 'https://raw.githubusercontent.com/ChaseFranz/discord-bot/main/helper/nimbus-music-helper.mjs'

  $ErrorActionPreference = 'Stop'
  # Windows PowerShell 5.1 downloads far more slowly while it draws a progress bar.
  $ProgressPreference = 'SilentlyContinue'
  # nodejs.org and GitHub need TLS 1.2, which older setups of Windows PowerShell don't offer by themselves.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  # The major version of a Node.js (22 for v22.4.1), or 0 if it won't run.
  function Get-NodeMajor([string]$Node) {
    try {
      $version = & $Node --version 2>$null
      if ($LASTEXITCODE -eq 0 -and "$version" -match '^v(\d+)\.') { return [int]$Matches[1] }
    } catch {
    }
    return 0
  }

  # Returns the Node.js kept in $Folder, downloading it the first time (and again whenever
  # $NodeVersion changes).
  function Install-Node([string]$Folder) {
    $major = [int]$NodeVersion.Split('.')[0]
    $dir = Join-Path $Folder "node-v$NodeVersion"
    $node = Join-Path $dir 'node.exe'
    if ((Get-NodeMajor $node) -eq $major) { return $node }

    # What Windows itself runs on, also when this PowerShell is a 32-bit one.
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    $platform = $null
    if ($arch -eq 'AMD64') { $platform = 'x64' } elseif ($arch -eq 'ARM64') { $platform = 'arm64' }
    if (-not $platform) {
      throw "There's no ready-made Node.js here for this kind of Windows ($arch). Install Node.js 22 or newer yourself (https://nodejs.org) and run this line again: it will use yours."
    }
    $name = "node-v$NodeVersion-win-$platform"

    Write-Host "Downloading Node.js $NodeVersion (about 40 MB, this once): the helper runs on it..."
    $work = Join-Path $Folder ('.download-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    # Nothing half-done is left behind, however this ends.
    try {
      $zip = Join-Path $work 'node.zip'
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$NodeDownloads/$name.zip" -OutFile $zip
      } catch {
        throw "Could not download Node.js from nodejs.org ($($_.Exception.Message)). Check your internet connection and try again."
      }
      if ((Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant() -ne $NodeSha256[$platform]) {
        throw 'The Node.js download did not match its known checksum, so it was not used. Try again in a minute.'
      }
      # Only the program itself is needed.
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $unpacked = Join-Path $work 'node.exe'
      $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
      try {
        $entry = $archive.GetEntry("$name/node.exe")
        if (-not $entry) { throw 'The Node.js download has no node.exe in it.' }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $unpacked)
      } finally {
        $archive.Dispose()
      }
      if ((Get-NodeMajor $unpacked) -ne $major) {
        throw "The Node.js that was downloaded won't start on this computer. Install Node.js 22 or newer yourself (https://nodejs.org) and run this line again: it will use yours."
      }
      # A version set up here before isn't needed any more.
      Get-ChildItem -Path $Folder -Directory -Filter 'node-v*' | Where-Object { $_.FullName -ne $dir } | Remove-Item -Recurse -Force
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
      Move-Item -Path $unpacked -Destination $node -Force
    } finally {
      Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Node.js $NodeVersion is ready."
    return $node
  }

  try {
    $folder = $env:NIMBUS_HELPER_HOME
    if (-not $folder) { $folder = Join-Path $env:USERPROFILE '.nimbus-music-helper' }
    New-Item -ItemType Directory -Path $folder -Force | Out-Null

    # Node.js: yours, if it is new enough; otherwise the one kept in the folder.
    $node = $null
    $yours = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($yours -and (Get-NodeMajor $yours.Path) -ge 22) { $node = $yours.Path }
    if (-not $node) { $node = Install-Node $folder }

    # The helper itself, the latest every time.
    $helper = Join-Path $folder 'nimbus-music-helper.mjs'
    $download = "$helper.download"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $HelperDownload -OutFile $download
      # Anything else (a sign-in page on a public network, say) is not the helper.
      if ((Get-Content -Path $download -TotalCount 1) -ne '#!/usr/bin/env node') { throw 'what came back was not the helper' }
      Move-Item -Path $download -Destination $helper -Force
    } catch {
      Remove-Item -Path $download -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path $helper)) {
        throw "Could not download the helper from GitHub ($($_.Exception.Message)). Check your internet connection and try again."
      }
      Write-Host 'Could not check for a newer helper, so starting the one you have.'
    }
  } catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ''
    return
  }

  # So that it says how to start it again with this line, not with the file.
  $env:NIMBUS_HELPER_INSTALLER = '1'
  if ($Code) { & $node $helper $Code } else { & $node $helper }
} $Code
