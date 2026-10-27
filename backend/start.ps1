param([int]$Port = 8000, [switch]$InitializeDatabase, [switch]$HttpsBootstrap)
$ErrorActionPreference = "Stop"
$backendDirectory = $PSScriptRoot
$backendPython = Join-Path $backendDirectory ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $backendPython)) { throw "Crea .venv e instala requirements.txt antes de iniciar." }
Push-Location -LiteralPath $backendDirectory
try {
    if ($InitializeDatabase) {
        if ($HttpsBootstrap) { & $backendPython -m scripts.init_db --https }
        else { & $backendPython -m scripts.init_db }
        if ($LASTEXITCODE -ne 0) { throw "No se pudo preparar PostgreSQL." }
    }
    & $backendPython -m uvicorn app.main:app --host 127.0.0.1 --port $Port
    if ($LASTEXITCODE -ne 0) { throw "El backend no pudo iniciarse." }
} finally { Pop-Location }
