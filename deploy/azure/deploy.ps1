param(
    [Parameter(Mandatory)]
    [string]$ResourceGroup,

    [Parameter(Mandatory)]
    [ValidateLength(2, 21)]
    [ValidatePattern("^(?!.*--)[a-z][a-z0-9-]*[a-z0-9]$")]
    [string]$NamePrefix,

    [string]$ParametersFile = (
        Join-Path $PSScriptRoot "main.bicepparam"
    )
)

$ErrorActionPreference = "Stop"

if ($NamePrefix -cne $NamePrefix.ToLowerInvariant()) {
    throw "NamePrefix must use lowercase characters"
}
if (-not (Test-Path -LiteralPath $ParametersFile)) {
    throw "Bicep parameters file was not found: $ParametersFile"
}

az deployment group create `
    --resource-group $ResourceGroup `
    --template-file (Join-Path $PSScriptRoot "main.bicep") `
    --parameters $ParametersFile `
    --parameters namePrefix=$NamePrefix
if ($LASTEXITCODE -ne 0) {
    throw "Azure deployment failed"
}
