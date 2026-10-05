$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected package version.' }
$files = @(
    'manifest.json', 'index.js', 'calendar-core.js', 'calendar.js', 'world-state.js', 'characters-core.js', 'character-cg.js', 'character-api.js', 'characters-engine.js', 'characters.js', 'snapshots.js', 'core.js', 'host-runtime.js', 'floating-window.js', 'embeddings.js',
    'keyword-ai.js', 'keyword-json.js', 'regex-runner.js', 'regex-worker.js',
    'settings.html', 'style.css', 'README.md'
)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packages = @(
    @{ Name = "world-os-$version.zip"; Prefix = 'floor-memory/' },
    @{ Name = "world-os-tauritavern-$version.zip"; Prefix = 'data/default-user/extensions/floor-memory/' }
)
foreach ($package in $packages) {
    $destination = Join-Path $projectRoot $package.Name
    $stream = [System.IO.File]::Open($destination, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite)
    $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($file in $files) {
            $source = Join-Path $projectRoot $file
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing runtime file: $file" }
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $source, ($package.Prefix + $file), [System.IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $archive.Dispose(); $stream.Dispose() }

    $verify = [System.IO.Compression.ZipFile]::OpenRead($destination)
    try {
        $expected = @($files | ForEach-Object { $package.Prefix + $_ })
        $actual = @($verify.Entries | ForEach-Object { $_.FullName })
        if (Compare-Object -ReferenceObject $expected -DifferenceObject $actual) { throw 'Archive paths differ from the runtime file list.' }
        foreach ($file in $files) {
            $entryStream = $verify.GetEntry($package.Prefix + $file).Open()
            $hasher = [System.Security.Cryptography.SHA256]::Create()
            try { $entryHash = [BitConverter]::ToString($hasher.ComputeHash($entryStream)).Replace('-', '') }
            finally { $entryStream.Dispose(); $hasher.Dispose() }
            $sourceHash = (Get-FileHash -LiteralPath (Join-Path $projectRoot $file) -Algorithm SHA256).Hash
            if ($entryHash -ne $sourceHash) { throw "Archive content mismatch: $file" }
        }
    } finally { $verify.Dispose() }
    $result = Get-Item -LiteralPath $destination
    Write-Output ("Verified {0}: {1} runtime files, {2} bytes" -f $result.Name, $files.Count, $result.Length)
}
