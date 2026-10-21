<#
  Windows Hello presence check for content-powerhouse (spike T0.0).

  Windows PowerShell 5.1 ONLY (powershell.exe, not pwsh): the WinRT projection used below does
  not exist in PowerShell 7.

  Calls Windows.Security.Credentials.UI.UserConsentVerifier:
    1. CheckAvailabilityAsync()
    2. RequestVerificationAsync(<Prompt>)   (only when Hello is available)
  and prints ONE line of JSON, for example:
    {"availability":"Available","result":"Verified"}
  The exit code is 0 whenever the JSON line was printed, and 1 when something threw (the line then
  carries "result":"Error" plus an "error" message). Only "Available" + "Verified" means yes.
#>
param(
  [string]$Prompt = 'content-powerhouse test'
)

$ErrorActionPreference = 'Stop'

function Write-Result([string]$availability, [string]$result, [string]$errorMessage) {
  $o = [ordered]@{ availability = $availability; result = $result }
  if ($errorMessage) { $o['error'] = $errorMessage }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
}

$availability = 'Unknown'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime

  # Load the WinRT types (this is the documented PowerShell 5.1 projection syntax).
  $verifier = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  $availabilityType = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  $resultType = [Windows.Security.Credentials.UI.UserConsentVerificationResult, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]

  # IAsyncOperation<T> has no PowerShell await; System.WindowsRuntimeSystemExtensions.AsTask turns it into a Task.
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  if ($null -eq $asTask) { throw 'AsTask(IAsyncOperation) not found' }

  function Wait-WinRt($operation, [Type]$resultClr) {
    $task = $asTask.MakeGenericMethod($resultClr).Invoke($null, @($operation))
    $task.Wait() | Out-Null
    return $task.Result
  }

  $availability = (Wait-WinRt ($verifier::CheckAvailabilityAsync()) $availabilityType).ToString()
  if ($availability -ne 'Available') {
    Write-Result $availability 'NotRequested' $null
    exit 0
  }

  $result = (Wait-WinRt ($verifier::RequestVerificationAsync($Prompt)) $resultType).ToString()
  Write-Result $availability $result $null
  exit 0
}
catch {
  Write-Result $availability 'Error' $_.Exception.Message
  exit 1
}
