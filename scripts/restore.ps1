param(
    [Parameter(Mandatory = $true)]
    [string]$BackupDirectory,
    [string]$ArtifactDirectory = ".data\production-artifacts",
    [string]$DatabaseUser = "postgres",
    [string]$DatabaseName = "agentic_data",
    [string]$ManifestKey = $env:BACKUP_MANIFEST_KEY,
    [switch]$ConfirmRestore
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "backup-common.ps1")
if (-not $ConfirmRestore) {
    throw "Pass -ConfirmRestore to acknowledge that database objects will be replaced."
}

$writers = docker compose ps -q app worker
if ($writers) {
    throw "Stop the app and worker services before restoring a coordinated backup."
}

$manifestKeyBytes = Get-BackupManifestKey $ManifestKey
$manifest = Read-VerifiedBackupManifest `
    -Directory $BackupDirectory `
    -Key $manifestKeyBytes
if ($manifest.schemaVersion -ne 1) {
    throw "Unsupported backup manifest version."
}
if (-not $manifest.migrations) {
    throw "Backup manifest does not contain migration metadata."
}
Assert-ExactMigrationManifest `
    -Actual @($manifest.migrations) `
    -Expected (Get-LocalMigrationManifest (
        Join-Path $PSScriptRoot "..\migrations\postgres"
    ))
Assert-BackupLeafName $manifest.database.file
$databasePath = Join-Path $BackupDirectory $manifest.database.file
$databaseHash = (Get-FileHash -LiteralPath $databasePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($databaseHash -ne $manifest.database.sha256) {
    throw "Database backup checksum does not match the manifest."
}

$artifactTarget = [System.IO.Path]::GetFullPath($ArtifactDirectory)
$artifactParent = Split-Path $artifactTarget -Parent
$artifactStage = Join-Path $artifactParent ".agentic-restore-stage-$PID"
$artifactRollback = Join-Path $artifactParent ".agentic-restore-rollback-$PID"

foreach ($path in @($artifactStage, $artifactRollback)) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}
New-Item -ItemType Directory -Path $artifactStage -Force | Out-Null

if ($manifest.artifacts) {
    Assert-BackupLeafName $manifest.artifacts.file
    $artifactArchive = Join-Path $BackupDirectory $manifest.artifacts.file
    $artifactHash = (Get-FileHash -LiteralPath $artifactArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($artifactHash -ne $manifest.artifacts.sha256) {
        Remove-Item -LiteralPath $artifactStage -Recurse -Force
        throw "Artifact backup checksum does not match the manifest."
    }
    Expand-Archive `
        -LiteralPath $artifactArchive `
        -DestinationPath $artifactStage
}

$container = docker compose ps -q postgres
if (-not $container) {
    Remove-Item -LiteralPath $artifactStage -Recurse -Force
    throw "The postgres container is not running."
}

$maintenanceOwner = "restore:$PID"
$acquired = docker exec $container psql `
    --username $DatabaseUser `
    --dbname $DatabaseName `
    --tuples-only `
    --no-align `
    --command "UPDATE agentic.maintenance_state SET active = TRUE, owner = '$maintenanceOwner', started_at = clock_timestamp() WHERE singleton = TRUE AND active = FALSE RETURNING 'acquired'"
if ($acquired -notcontains "acquired") {
    Remove-Item -LiteralPath $artifactStage -Recurse -Force
    throw "Another maintenance operation is already active."
}

$containerFile = "/tmp/$($manifest.database.file)"
$artifactSwapped = $false
$databaseRestored = $false
try {
    New-Item -ItemType Directory -Path $artifactParent -Force | Out-Null
    if (Test-Path -LiteralPath $artifactTarget) {
        Move-Item -LiteralPath $artifactTarget -Destination $artifactRollback
    }
    Move-Item -LiteralPath $artifactStage -Destination $artifactTarget
    $artifactSwapped = $true

    docker cp $databasePath "${container}:$containerFile"
    if ($LASTEXITCODE -ne 0) {
        throw "docker cp failed."
    }

    docker exec $container pg_restore `
        --username $DatabaseUser `
        --dbname $DatabaseName `
        --clean `
        --if-exists `
        --no-owner `
        --single-transaction `
        --exit-on-error `
        $containerFile
    if ($LASTEXITCODE -ne 0) {
        throw "pg_restore failed."
    }
    $databaseRestored = $true
    Assert-ExactMigrationManifest `
        -Actual (Get-DatabaseMigrationManifest `
            -Container $container `
            -DatabaseUser $DatabaseUser `
            -DatabaseName $DatabaseName) `
        -Expected @($manifest.migrations)
} catch {
    if (-not $databaseRestored) {
        if ($artifactSwapped -and (Test-Path -LiteralPath $artifactTarget)) {
            Remove-Item -LiteralPath $artifactTarget -Recurse -Force
        }
        if (Test-Path -LiteralPath $artifactRollback) {
            Move-Item -LiteralPath $artifactRollback -Destination $artifactTarget
        }
    } elseif (Test-Path -LiteralPath $artifactRollback) {
        Write-Warning (
            "Database restore committed before verification failed. " +
            "Restored artifacts remain active; prior artifacts are retained at " +
            $artifactRollback
        )
    }
    throw
} finally {
    docker exec $container rm -f $containerFile 2>$null | Out-Null
    docker exec $container psql `
        --username $DatabaseUser `
        --dbname $DatabaseName `
        --command "UPDATE agentic.maintenance_state SET active = FALSE, owner = NULL, started_at = NULL WHERE singleton = TRUE" `
        2>$null | Out-Null
    if (Test-Path -LiteralPath $artifactStage) {
        Remove-Item -LiteralPath $artifactStage -Recurse -Force
    }
}

if (Test-Path -LiteralPath $artifactRollback) {
    Remove-Item -LiteralPath $artifactRollback -Recurse -Force
}

Write-Output "Restore completed."
