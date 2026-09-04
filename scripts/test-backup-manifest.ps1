$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "backup-common.ps1")

$directory = Join-Path (
    [System.IO.Path]::GetTempPath()
) "agentic-backup-manifest-$PID"
$key = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
try {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $manifest = [ordered]@{
        schemaVersion = 1
        database = @{
            file = "database.dump"
            sha256 = "a" * 64
        }
        artifacts = $null
    }
    Write-SignedBackupManifest `
        -Manifest $manifest `
        -Directory $directory `
        -Key $key
    $verified = Read-VerifiedBackupManifest `
        -Directory $directory `
        -Key $key
    if ($verified.database.file -ne "database.dump") {
        throw "Verified manifest content changed."
    }
    Assert-BackupLeafName $verified.database.file
    try {
        Assert-BackupLeafName "..\outside.dump"
        throw "Unsafe manifest path was accepted."
    } catch {
        if ($_.Exception.Message -eq "Unsafe manifest path was accepted.") {
            throw
        }
    }
    try {
        Assert-BackupLeafName "../outside.dump"
        throw "Unsafe manifest path was accepted."
    } catch {
        if ($_.Exception.Message -eq "Unsafe manifest path was accepted.") {
            throw
        }
    }
    Add-Content `
        -LiteralPath (Join-Path $directory "manifest.json") `
        -Value " "
    try {
        Read-VerifiedBackupManifest `
            -Directory $directory `
            -Key $key | Out-Null
        throw "Tampered manifest was accepted."
    } catch {
        if ($_.Exception.Message -eq "Tampered manifest was accepted.") {
            throw
        }
    }
    Write-Output "Backup manifest signing validated."
} finally {
    if (Test-Path -LiteralPath $directory) {
        Remove-Item -LiteralPath $directory -Recurse -Force
    }
}
