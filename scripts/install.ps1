$ErrorActionPreference = "Stop"

$Repo = "hjinco/syncdown"
$InstallDir = if ($env:SYNCDOWN_INSTALL_DIR) { $env:SYNCDOWN_INSTALL_DIR } else { Join-Path $HOME "AppData\Local\Programs\syncdown\bin" }

function Normalize-Tag([string]$Version) {
  if ($Version.StartsWith("cli-v")) {
    return $Version
  }

  if ($Version.StartsWith("v")) {
    return "cli-$Version"
  }

  return "cli-v$Version"
}

function Get-VersionFromTag([string]$Tag) {
  if ($Tag -notmatch '^cli-v(?<version>\d+\.\d+\.\d+)$') {
    throw "Invalid CLI release tag: $Tag"
  }

  return [Version]$Matches.version
}

function Resolve-Tag {
  if ($env:SYNCDOWN_VERSION) {
    return Normalize-Tag $env:SYNCDOWN_VERSION
  }

  $response = Invoke-WebRequest -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases?per_page=100"
  $releases = $response.Content | ConvertFrom-Json
  $release = $releases |
    Where-Object { -not $_.draft -and -not $_.prerelease -and $_.tag_name -match '^cli-v\d+\.\d+\.\d+$' } |
    Sort-Object { Get-VersionFromTag $_.tag_name } -Descending |
    Select-Object -First 1
  if (-not $release.tag_name) {
    throw "Unable to resolve latest CLI release tag."
  }

  return $release.tag_name
}

function Get-ExpectedChecksum([string]$ChecksumsPath, [string]$AssetName) {
  foreach ($line in Get-Content -LiteralPath $ChecksumsPath) {
    if ($line -match '^(?<hash>[a-fA-F0-9]+)\s+(?<file>.+)$' -and $Matches.file -eq $AssetName) {
      return $Matches.hash.ToLowerInvariant()
    }
  }

  throw "Missing checksum entry for $AssetName."
}

$Tag = Resolve-Tag
$AssetName = "syncdown-$Tag-windows-x64.zip"
$ChecksumsName = "syncdown-$Tag-SHA256SUMS.txt"
$BaseUrl = "https://github.com/$Repo/releases/download/$Tag"
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("syncdown-install-" + [guid]::NewGuid().ToString("N"))
$ArchivePath = Join-Path $TempRoot $AssetName
$ChecksumsPath = Join-Path $TempRoot $ChecksumsName

New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

try {
  Write-Host "Downloading $AssetName"
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$AssetName" -OutFile $ArchivePath
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$ChecksumsName" -OutFile $ChecksumsPath

  $Expected = Get-ExpectedChecksum -ChecksumsPath $ChecksumsPath -AssetName $AssetName
  $Actual = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()

  if ($Expected -ne $Actual) {
    throw "Checksum mismatch for $AssetName."
  }

  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $InstallDir -Force

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $PathEntries = @()
  if ($UserPath) {
    $PathEntries = $UserPath.Split(";") | Where-Object { $_ }
  }

  if (-not ($PathEntries -contains $InstallDir)) {
    $NextPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable("Path", $NextPath, "User")
    Write-Host "Added $InstallDir to your user PATH."
  }

  Write-Host "Installed syncdown to $(Join-Path $InstallDir 'syncdown.exe')"
} finally {
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
