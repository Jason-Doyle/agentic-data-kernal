function Get-BackupManifestKey {
    param([string]$EncodedKey)

    if (-not $EncodedKey) {
        throw "BACKUP_MANIFEST_KEY is required."
    }
    try {
        $key = [Convert]::FromBase64String($EncodedKey)
    } catch {
        throw "BACKUP_MANIFEST_KEY must be valid base64."
    }
    if ($key.Length -ne 32) {
        throw "BACKUP_MANIFEST_KEY must decode to exactly 32 bytes."
    }
    return $key
}

function Write-SignedBackupManifest {
    param(
        [object]$Manifest,
        [string]$Directory,
        [byte[]]$Key
    )

    $manifestPath = Join-Path $Directory "manifest.json"
    $signaturePath = Join-Path $Directory "manifest.hmac"
    $json = $Manifest | ConvertTo-Json -Depth 8 -Compress
    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($manifestPath, $json, $encoding)
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($Key)
    try {
        $signature = $hmac.ComputeHash(
            [System.IO.File]::ReadAllBytes($manifestPath)
        )
    } finally {
        $hmac.Dispose()
    }
    [System.IO.File]::WriteAllText(
        $signaturePath,
        [Convert]::ToHexString($signature).ToLowerInvariant(),
        $encoding
    )
}

function Read-VerifiedBackupManifest {
    param(
        [string]$Directory,
        [byte[]]$Key
    )

    $manifestPath = Join-Path $Directory "manifest.json"
    $signaturePath = Join-Path $Directory "manifest.hmac"
    if (
        -not (Test-Path -LiteralPath $manifestPath) -or
        -not (Test-Path -LiteralPath $signaturePath)
    ) {
        throw "Signed manifest files are required."
    }
    $signatureText = (
        Get-Content -LiteralPath $signaturePath -Raw
    ).Trim()
    if ($signatureText -notmatch "^[a-f0-9]{64}$") {
        throw "Backup manifest signature is invalid."
    }
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($Key)
    try {
        $actual = $hmac.ComputeHash(
            [System.IO.File]::ReadAllBytes($manifestPath)
        )
    } finally {
        $hmac.Dispose()
    }
    $expected = [Convert]::FromHexString($signatureText)
    if (
        -not [System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals(
            $actual,
            $expected
        )
    ) {
        throw "Backup manifest signature does not match."
    }
    return Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
}

function Assert-BackupLeafName {
    param([string]$Name)

    if (
        -not $Name -or
        $Name -match '[/\\:]' -or
        [System.IO.Path]::GetFileName($Name) -ne $Name -or
        $Name -in @(".", "..")
    ) {
        throw "Backup manifest contains an invalid file name."
    }
}

function Get-LocalMigrationManifest {
    param([string]$Directory)

    return @(
        Get-ChildItem -LiteralPath $Directory -Filter "*.sql" |
            Where-Object { $_.Name -match '^\d+_.+\.sql$' } |
            Sort-Object Name |
            ForEach-Object {
                [ordered]@{
                    version = ($_.BaseName -split "_", 2)[0]
                    checksum = (
                        Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
                    ).Hash.ToLowerInvariant()
                }
            }
    )
}

function Get-DatabaseMigrationManifest {
    param(
        [string]$Container,
        [string]$DatabaseUser,
        [string]$DatabaseName
    )

    $output = docker exec $Container psql `
        --username $DatabaseUser `
        --dbname $DatabaseName `
        --tuples-only `
        --no-align `
        --set=ON_ERROR_STOP=1 `
        --command "SELECT COALESCE(json_agg(json_build_object('version', version, 'checksum', checksum) ORDER BY version), '[]'::json)::text FROM agentic.schema_migrations"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not read the database migration manifest."
    }
    return @((($output -join "").Trim() | ConvertFrom-Json))
}

function Assert-ExactMigrationManifest {
    param(
        [object[]]$Actual,
        [object[]]$Expected
    )

    $actualLines = @(
        $Actual |
            ForEach-Object { "$($_.version)|$($_.checksum)" } |
            Sort-Object
    )
    $expectedLines = @(
        $Expected |
            ForEach-Object { "$($_.version)|$($_.checksum)" } |
            Sort-Object
    )
    if (
        $actualLines.Count -ne $expectedLines.Count -or
        (Compare-Object $actualLines $expectedLines)
    ) {
        throw "Backup migration manifest does not match this runtime."
    }
}
