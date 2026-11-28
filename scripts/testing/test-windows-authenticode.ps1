# Exercise the release verifier on an isolated PE without trusting a test key.
$ErrorActionPreference = 'Stop'
$directory = New-Item -ItemType Directory (Join-Path ([IO.Path]::GetTempPath()) "nodex-authenticode-$([guid]::NewGuid())")
$certificate = $null
try {
  $image = Join-Path $directory.FullName 'nodex-authenticode-test.dll'
  Add-Type -TypeDefinition 'public sealed class NodexAuthenticodeTest {}' -OutputAssembly $image
  $verify = Join-Path $PSScriptRoot '../verify-windows-authenticode.ps1'

  function Assert-Rejected([string]$Fingerprint) {
    try {
      & $verify -Installer $image -CertificateSha256 $Fingerprint
    } catch {
      if ($_.Exception.Message -like '*must have a trusted, embedded Authenticode signature*') { return }
      throw
    }
    throw 'Verifier accepted an unsigned or untrusted PE.'
  }

  Assert-Rejected ('0' * 64)
  $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Nodex Authenticode CI test' -NotAfter (Get-Date).AddDays(1) -CertStoreLocation 'Cert:\CurrentUser\My'
  Set-AuthenticodeSignature -LiteralPath $image -Certificate $certificate -HashAlgorithm SHA256 | Out-Null
  $signed = Get-AuthenticodeSignature -LiteralPath $image
  if ($signed.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
    throw 'The disposable certificate did not sign the test PE.'
  }
  Assert-Rejected ($certificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256))
  Write-Host 'Authenticode rejected unsigned PE input and PE input signed with a disposable certificate.'
} finally {
  if ($certificate) {
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -DeleteKey -Confirm:$false
  }
  Remove-Item -LiteralPath $directory.FullName -Recurse -Force
}
