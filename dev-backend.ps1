param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
Push-Location -LiteralPath $PSScriptRoot
try {
    & uv run uvicorn app.main:app --host 127.0.0.1 --port $Port --app-dir backend --env-file .env --reload --reload-dir backend/app
    $serverExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $serverExitCode
