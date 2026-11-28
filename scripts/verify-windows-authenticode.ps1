param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$CertificateSha256
)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $Installer
if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode') {
  throw "Installer must have a trusted, embedded Authenticode signature. Status: $($signature.Status)."
}

$actual = $signature.SignerCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)
if ($actual -ne $CertificateSha256) {
  throw "Installer signing certificate SHA-256 does not match the configured publisher. Actual: $actual."
}

if (!$signature.TimeStamperCertificate) {
  throw 'Installer Authenticode signature must be timestamped.'
}

Write-Host "Verified timestamped Authenticode signature from $($signature.SignerCertificate.Subject)."
