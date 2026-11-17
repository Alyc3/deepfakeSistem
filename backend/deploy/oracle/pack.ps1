# Empaqueta el backend para copiarlo a la VM de Oracle Cloud.
#
# Uso, desde la carpeta backend\ en PowerShell:
#   powershell -ExecutionPolicy Bypass -File deploy\oracle\pack.ps1
#
# Genera %USERPROFILE%\certiface-backend.tgz con el código, .env, .secrets\ y keys\. Deja
# fuera lo pesado o local: el entorno virtual, el catálogo de calibración y los
# pesos grandes (la VM los descarga de sus fuentes oficiales al construir).
# El archivo contiene secretos: cópialo solo por scp y bórralo al terminar.
$ErrorActionPreference = "Stop"
$backend = Resolve-Path (Join-Path $PSScriptRoot "..\..")
# Fuera del repositorio: el paquete lleva .env y la clave privada.
$output = Join-Path $env:USERPROFILE "certiface-backend.tgz"

$exclude = @(
  ".venv", "venv", "__pycache__", "*.pyc", ".pytest_cache",
  "Catologo de videos", "calibracion", "uploads", "storage_evidence", "logs", ".runtime-tmp",
  "Detector_De_Face_Swap.pth", "model.safetensors", "weights.pth",
  "instance_oracle.png", "details.png", "deploy/oracle/.env"
)
$arguments = @("-czf", $output)
foreach ($pattern in $exclude) { $arguments += "--exclude=$pattern" }
$arguments += @("-C", $backend, ".")

Write-Host "Empaquetando $backend ..."
& "$env:SystemRoot\System32\tar.exe" @arguments
if ($LASTEXITCODE -ne 0) { throw "tar terminó con código $LASTEXITCODE" }

$size = [math]::Round((Get-Item $output).Length / 1MB, 1)
Write-Host "Listo: $output ($size MB)"
Write-Host "Copialo a la VM con:  scp -i <tu-clave-privada> `"$output`" ubuntu@<IP-PUBLICA>:~/"
