$ErrorActionPreference = "Stop"

$destination = Join-Path $PSScriptRoot "..\.data\backup-drill"
$artifacts = Join-Path $PSScriptRoot "..\.data\backup-drill-artifacts"
$key = [Convert]::ToBase64String(
    [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
)
try {
    $backupDirectory = & (Join-Path $PSScriptRoot "backup.ps1") `
        -Destination $destination `
        -ArtifactDirectory $artifacts `
        -ManifestKey $key
    if (-not $backupDirectory) {
        throw "Backup drill did not return a backup directory."
    }
    $manifestPath = Join-Path $backupDirectory "manifest.json"
    $originalManifest = [System.IO.File]::ReadAllBytes($manifestPath)
    Add-Content -LiteralPath $manifestPath -Value " "
    try {
        & (Join-Path $PSScriptRoot "restore.ps1") `
            -BackupDirectory $backupDirectory `
            -ArtifactDirectory $artifacts `
            -ManifestKey $key `
            -ConfirmRestore
        throw "Restore accepted a tampered manifest."
    } catch {
        if ($_.Exception.Message -eq "Restore accepted a tampered manifest.") {
            throw
        }
    }
    [System.IO.File]::WriteAllBytes(
        $manifestPath,
        $originalManifest
    )
    & (Join-Path $PSScriptRoot "restore.ps1") `
        -BackupDirectory $backupDirectory `
        -ArtifactDirectory $artifacts `
        -ManifestKey $key `
        -ConfirmRestore
    Write-Output "Backup and restore drill completed."
} finally {
    foreach ($path in @($destination, $artifacts)) {
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }
}

