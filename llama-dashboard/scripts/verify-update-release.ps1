param(
  [switch]$RequireSigned,
  [string]$Tag
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-FileDigest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath,
    [Parameter(Mandatory = $true)]
    [ValidateSet("SHA1", "SHA256")]
    [string]$Algorithm
  )

  $hashAlgorithm = if ($Algorithm -eq "SHA1") {
    [Security.Cryptography.SHA1]::Create()
  } else {
    [Security.Cryptography.SHA256]::Create()
  }
  $stream = [IO.File]::Open($LiteralPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    return ([BitConverter]::ToString($hashAlgorithm.ComputeHash($stream)) -replace "-", "")
  } finally {
    $stream.Dispose()
    $hashAlgorithm.Dispose()
  }
}

$authenticodeCommand = Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue
if ($RequireSigned -and -not $authenticodeCommand) {
  throw "Signed verification requires Get-AuthenticodeSignature, but this PowerShell host does not provide it."
}

$dashboardRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$package = Get-Content -LiteralPath (Join-Path $dashboardRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
$expectedTag = "v$version"
if ($Tag -and $Tag -ne $expectedTag) {
  throw "Release tag '$Tag' does not match llama-dashboard/package.json version '$version' (expected '$expectedTag')."
}

$makeDir = Join-Path $dashboardRoot "out\make\squirrel.windows\x64"
$setupPath = Join-Path $makeDir "Llama-Score-Dashboard-Setup.exe"
$nupkgName = "LlamaScoreDashboard-$version-full.nupkg"
$nupkgPath = Join-Path $makeDir $nupkgName
$releasesPath = Join-Path $makeDir "RELEASES"
$portableZipPath = Join-Path $dashboardRoot "release\Llama-Score-Dashboard-win32-x64.zip"
$portableAppPath = Join-Path $dashboardRoot "release\Llama Score Dashboard-win32-x64\resources\app"
$installerAppPath = Join-Path $dashboardRoot "out\Llama Score Dashboard-win32-x64\resources\app"

foreach ($requiredPath in @($setupPath, $nupkgPath, $releasesPath, $portableZipPath, $portableAppPath, $installerAppPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required release artifact is missing: $requiredPath"
  }
}

$expectedMakeNames = @("Llama-Score-Dashboard-Setup.exe", $nupkgName, "RELEASES") | Sort-Object
$actualMakeNames = @(Get-ChildItem -LiteralPath $makeDir -File | ForEach-Object Name | Sort-Object)
if ([string]::Join("|", $actualMakeNames) -ne [string]::Join("|", $expectedMakeNames)) {
  throw "Squirrel output contains unexpected or stale files: $($actualMakeNames -join ', ')"
}

$releaseLine = (Get-Content -LiteralPath $releasesPath -Raw).Trim()
$releaseMatch = [regex]::Match($releaseLine, "^(?<sha>[0-9a-fA-F]{40}) (?<file>\S+) (?<size>\d+)$")
if (-not $releaseMatch.Success) {
  throw "RELEASES has an unexpected format: $releaseLine"
}
if ($releaseMatch.Groups["file"].Value -ne $nupkgName) {
  throw "RELEASES points at '$($releaseMatch.Groups["file"].Value)', expected '$nupkgName'."
}
$nupkgInfo = Get-Item -LiteralPath $nupkgPath
if ([int64]$releaseMatch.Groups["size"].Value -ne $nupkgInfo.Length) {
  throw "RELEASES size does not match $nupkgName."
}
$nupkgSha1 = Get-FileDigest -LiteralPath $nupkgPath -Algorithm SHA1
if ($releaseMatch.Groups["sha"].Value -ne $nupkgSha1) {
  throw "RELEASES SHA-1 does not match $nupkgName."
}

$releaseRoot = Join-Path $dashboardRoot "release"
$expectedReleaseNames = @("Llama Score Dashboard-win32-x64", "Llama-Score-Dashboard-win32-x64.zip") | Sort-Object
$actualReleaseNames = @(Get-ChildItem -LiteralPath $releaseRoot | ForEach-Object Name | Sort-Object)
if ([string]::Join("|", $actualReleaseNames) -ne [string]::Join("|", $expectedReleaseNames)) {
  throw "Canonical release root contains unexpected entries: $($actualReleaseNames -join ', ')"
}

$portableZip = [IO.Compression.ZipFile]::OpenRead($portableZipPath)
try {
  $portableNames = @($portableZip.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
  $topNames = @($portableNames | ForEach-Object { $_.Split("/")[0] } | Sort-Object -Unique)
  if ($topNames.Count -ne 1 -or $topNames[0] -ne "Llama-Score-Dashboard-win32-x64") {
    throw "Portable ZIP top-level entry is wrong: $($topNames -join ', ')"
  }
  if (-not ($portableNames -contains "Llama-Score-Dashboard-win32-x64/data/")) {
    throw "Portable ZIP is missing its explicit empty data/ directory."
  }
  $portableDataFiles = @($portableNames | Where-Object {
    $_ -match "^Llama-Score-Dashboard-win32-x64/data/.+" -and -not $_.EndsWith("/")
  })
  if ($portableDataFiles.Count) {
    throw "Portable ZIP contains campaign data: $($portableDataFiles -join ', ')"
  }
} finally {
  $portableZip.Dispose()
}

$nupkg = [IO.Compression.ZipFile]::OpenRead($nupkgPath)
try {
  $nupkgEntries = @($nupkg.Entries)
  $nupkgDataFiles = @($nupkgEntries | Where-Object {
    $name = $_.FullName.Replace("\", "/")
    $name -match "/resources/app/data/.+" -and -not $name.EndsWith("/")
  })
  if ($nupkgDataFiles.Count) {
    throw "Squirrel package contains campaign data: $($nupkgDataFiles.FullName -join ', ')"
  }

  if ($RequireSigned) {
    $mainExeEntry = $nupkgEntries | Where-Object {
      $_.FullName.Replace("\", "/") -match "/LlamaScoreDashboard\.exe$"
    } | Select-Object -First 1
    if (-not $mainExeEntry) {
      throw "Could not find LlamaScoreDashboard.exe inside $nupkgName."
    }
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) "llama-release-signature-$([guid]::NewGuid())"
    $resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
    $resolvedSystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\")
    if (-not $resolvedTempRoot.StartsWith($resolvedSystemTemp + "\", [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFileName($resolvedTempRoot).StartsWith("llama-release-signature-")) {
      throw "Refusing to use unexpected signature-verification temp path: $resolvedTempRoot"
    }
    New-Item -ItemType Directory -Path $resolvedTempRoot | Out-Null
    try {
      $extractedExe = Join-Path $resolvedTempRoot "LlamaScoreDashboard.exe"
      [IO.Compression.ZipFileExtensions]::ExtractToFile($mainExeEntry, $extractedExe)
      $appSignature = Get-AuthenticodeSignature -LiteralPath $extractedExe
      if ($appSignature.Status -ne "Valid") {
        throw "Packaged application executable is not validly signed: $($appSignature.Status)"
      }
    } finally {
      Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
    }
  }
} finally {
  $nupkg.Dispose()
}

$runtimeFiles = @(
  "main.js",
  "preload.js",
  "data-paths.js",
  "update-policy.js",
  "vendor\llama-score-automatic-logging-machine\llama-log-machine.js",
  "vendor\llama-score-automatic-logging-machine\parse-worker.js"
)
foreach ($relativePath in $runtimeFiles) {
  $sourceHash = Get-FileDigest -LiteralPath (Join-Path $dashboardRoot $relativePath) -Algorithm SHA256
  foreach ($appRoot in @($portableAppPath, $installerAppPath)) {
    $packagedHash = Get-FileDigest -LiteralPath (Join-Path $appRoot $relativePath) -Algorithm SHA256
    if ($sourceHash -ne $packagedHash) {
      throw "Packaged runtime does not match source: $relativePath in $appRoot"
    }
  }
}

# Electron Forge is allowed to normalize package.json while pruning development
# dependencies. Verify the fields that define the shipped app and require the
# complete production dependency set instead of comparing formatting bytes.
$packageIdentityFields = @("name", "version", "productName", "main")
foreach ($appRoot in @($portableAppPath, $installerAppPath)) {
  $packagedPackagePath = Join-Path $appRoot "package.json"
  $packagedPackage = Get-Content -LiteralPath $packagedPackagePath -Raw | ConvertFrom-Json
  foreach ($field in $packageIdentityFields) {
    if ([string]$packagedPackage.$field -ne [string]$package.$field) {
      throw "Packaged package.json has an unexpected '$field' value in $appRoot."
    }
  }

  $sourceDependencyNames = @($package.dependencies.PSObject.Properties.Name | Sort-Object)
  $packagedDependencyNames = @($packagedPackage.dependencies.PSObject.Properties.Name | Sort-Object)
  if ([string]::Join("|", $packagedDependencyNames) -ne [string]::Join("|", $sourceDependencyNames)) {
    throw "Packaged package.json has an unexpected production dependency set in $appRoot."
  }
  foreach ($dependencyName in $sourceDependencyNames) {
    if ([string]$packagedPackage.dependencies.$dependencyName -ne [string]$package.dependencies.$dependencyName) {
      throw "Packaged package.json has an unexpected '$dependencyName' version in $appRoot."
    }
  }
}

$setupSignatureStatus = if ($authenticodeCommand) {
  [string](Get-AuthenticodeSignature -LiteralPath $setupPath).Status
} else {
  "Unavailable"
}
if ($RequireSigned -and $setupSignatureStatus -ne "Valid") {
  throw "Setup.exe is not validly signed: $setupSignatureStatus"
}

foreach ($artifact in @($setupPath, $nupkgPath, $releasesPath, $portableZipPath)) {
  $item = Get-Item -LiteralPath $artifact
  $sha256 = Get-FileDigest -LiteralPath $artifact -Algorithm SHA256
  Write-Output "VERIFIED|$($item.Name)|$($item.Length)|SHA256=$sha256"
}
Write-Output "VERIFIED|version=$version|tag=$expectedTag|signature=$setupSignatureStatus|campaignDataFiles=0"
