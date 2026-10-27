$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$principal = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($relative in @('.secrets', '.runtime-tmp', 'logs', '.env')) {
    $target = Join-Path $backendRoot $relative
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $resolved = (Resolve-Path -LiteralPath $target).Path
    if (-not $resolved.StartsWith($backendRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Ruta privada fuera del backend' }
    $directory = (Get-Item -LiteralPath $resolved).PSIsContainer
    $inherit = if ($directory) { '(OI)(CI)' } else { '' }
    & icacls $resolved '/inheritance:r' '/grant:r' "${principal}:${inherit}F" "*S-1-5-18:${inherit}F" "*S-1-5-32-544:${inherit}F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron restringir los permisos privados' }
}
Write-Output 'Acceso a secretos, entorno y temporales restringido al usuario del proceso, SYSTEM y administradores.'
