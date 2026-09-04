param(
    [string]$Destination = ".backups",
    [string]$ArtifactDirectory = ".data\production-artifacts",
    [string]$DatabaseUser = "postgres",
    [string]$DatabaseName = "agentic_data",
    [string]$ManifestKey = $env:BACKUP_MANIFEST_KEY
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "backup-common.ps1")
$manifestKeyBytes = Get-BackupManifestKey $ManifestKey
$writers = docker compose ps -q app worker
if ($writers) {
    throw "Stop the app and worker services before creating a coordinated backup."
}
$container = docker compose ps -q postgres
if (-not $container) {
    throw "The postgres container is not running."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$owner = "backup:$timestamp"
$acquired = docker exec $container psql `
    --username $DatabaseUser `
    --dbname $DatabaseName `
    --tuples-only `
    --no-align `
    --command "UPDATE agentic.maintenance_state SET active = TRUE, owner = '$owner', started_at = clock_timestamp() WHERE singleton = TRUE AND active = FALSE RETURNING 'acquired'"
if ($acquired -notcontains "acquired") {
    throw "Another maintenance operation is already active."
}

$backupDirectory = Join-Path $Destination $timestamp
$databaseFile = "agentic-data-$timestamp.dump"
$containerFile = "/tmp/$databaseFile"
$localDatabaseFile = Join-Path $backupDirectory $databaseFile

try {
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null

    docker exec $container pg_dump `
        --username $DatabaseUser `
        --dbname $DatabaseName `
        --format custom `
        --file $containerFile
    if ($LASTEXITCODE -ne 0) {
        throw "pg_dump failed."
    }

    docker cp "${container}:$containerFile" $localDatabaseFile
    if ($LASTEXITCODE -ne 0) {
        throw "docker cp failed."
    }
    $migrations = Get-DatabaseMigrationManifest `
        -Container $container `
        -DatabaseUser $DatabaseUser `
        -DatabaseName $DatabaseName
    Assert-ExactMigrationManifest `
        -Actual $migrations `
        -Expected (Get-LocalMigrationManifest (
            Join-Path $PSScriptRoot "..\migrations\postgres"
        ))

    $artifactArchive = $null
    if (
        (Test-Path -LiteralPath $ArtifactDirectory) -and
        (Get-ChildItem -LiteralPath $ArtifactDirectory -Force | Select-Object -First 1)
    ) {
        $artifactArchive = Join-Path $backupDirectory "artifacts-$timestamp.zip"
        Compress-Archive `
            -Path (Join-Path $ArtifactDirectory "*") `
            -DestinationPath $artifactArchive `
            -CompressionLevel Optimal
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        database = @{
            file = $databaseFile
            sha256 = (Get-FileHash -LiteralPath $localDatabaseFile -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        migrations = $migrations
        artifacts = if ($artifactArchive) {
            @{
                file = Split-Path $artifactArchive -Leaf
                sha256 = (Get-FileHash -LiteralPath $artifactArchive -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        } else {
            $null
        }
    }

    Write-SignedBackupManifest `
        -Manifest $manifest `
        -Directory $backupDirectory `
        -Key $manifestKeyBytes

    Write-Output $backupDirectory
} finally {
    docker exec $container rm -f $containerFile 2>$null | Out-Null
    docker exec $container psql `
        --username $DatabaseUser `
        --dbname $DatabaseName `
        --command "UPDATE agentic.maintenance_state SET active = FALSE, owner = NULL, started_at = NULL WHERE singleton = TRUE" `
        2>$null | Out-Null
}
