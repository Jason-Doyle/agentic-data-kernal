$pepper = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
$artifactKey = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))

[PSCustomObject]@{
    AUTH_PEPPER = $pepper
    ARTIFACT_CURRENT_KEY_ID = "v1"
    ARTIFACT_KEYRING = "{`"v1`":`"$artifactKey`"}"
} | Format-List
