<#
.SYNOPSIS
Starts only the stateless flight function and browser prototype.

.DESCRIPTION
The API (uvicorn --reload) restarts when files under backend/app change. Vite reloads the page when frontend files
change and forwards /api to the API. A port in use is replaced by the next free port. Output of each process has an
[api] or [web] prefix. Ctrl+C stops both.
#>
param(
    [ValidateRange(1, 65535)][int]$Port = 8010,
    [ValidateRange(1, 65535)][int]$WebPort = 5174
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) { throw 'uv is not installed. See README.md, Run on Windows.' }
if (-not (Test-Path (Join-Path $root 'frontend/node_modules'))) { throw 'Frontend packages are missing. Run: npm --prefix frontend install' }

$colors = @{ api = 'Cyan'; web = 'Green'; start = 'Gray' }
function Write-Line([string]$Tag, [string]$Text) {
    Write-Host ('{0} [{1}] {2}' -f (Get-Date -Format 'HH:mm:ss'), $Tag, $Text) -ForegroundColor $colors[$Tag]
}
# The first free port from $Wanted, trying up to 20 ports above it.
function Get-FreePort([int]$Wanted, [string]$Tag, [int[]]$Taken = @()) {
    foreach ($candidate in $Wanted..[Math]::Min($Wanted + 20, 65535)) {
        if ($candidate -in $Taken) { continue }
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
        try { $listener.Start(); $listener.Stop() } catch { continue }
        if ($candidate -ne $Wanted) { Write-Line 'start' "Port $Wanted is in use; $Tag uses port $candidate" }
        return $candidate
    }
    throw "Ports $Wanted to $($Wanted + 20) are all in use"
}
& $uv run python tools/prepare_browser_poc.py
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare browser Python assets.' }

$Port = Get-FreePort $Port 'api'
$WebPort = Get-FreePort $WebPort 'web' @($Port)
$apiUrl = "http://127.0.0.1:$Port"
$processes = [ordered]@{}
function Start-Managed([string]$Tag, [string]$FileName, [string[]]$Arguments, [string]$WorkingDirectory) {
    $info = [Diagnostics.ProcessStartInfo]::new($FileName)
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    $info.Environment['PYTHONUNBUFFERED'] = '1'
    $info.Environment['PYTHONIOENCODING'] = 'utf-8'
    $info.Environment['POC_API_URL'] = $apiUrl  # Vite forwards /api here (vite.config.ts).
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    [void]$process.Start()
    Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -MessageData $Tag | Out-Null
    Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -MessageData $Tag | Out-Null
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()
    $processes[$Tag] = $process
    Write-Line 'start' "$Tag started (pid $($process.Id))"
}
function Receive-Lines {
    $received = $false
    foreach ($event in Get-Event) {
        $received = $true
        if ($null -ne $event.SourceEventArgs.Data) { Write-Line $event.MessageData $event.SourceEventArgs.Data }
        Remove-Event -EventIdentifier $event.EventIdentifier
    }
    return $received
}

try {
    $apiArguments = @('run', 'uvicorn', 'api.flights:app', '--host', '127.0.0.1', '--port', "$Port", '--reload', '--reload-dir', 'backend/app', '--reload-dir', 'api')
    # uvicorn refuses an --env-file that does not exist.
    if (Test-Path (Join-Path $root '.env')) { $apiArguments += @('--env-file', '.env') }
    else { Write-Line 'start' 'No .env file: using defaults. To configure, run: Copy-Item .env.example .env' }
    Start-Managed 'api' $uv $apiArguments $root

    $deadline = (Get-Date).AddSeconds(60)
    $healthy = $false
    while (-not $healthy -and (Get-Date) -lt $deadline -and -not $processes.api.HasExited) {
        try { $healthy = (Invoke-WebRequest "$apiUrl/api/flights" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
        [void](Receive-Lines)
        if (-not $healthy) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $healthy) { throw "The API did not start at $apiUrl" }
    Write-Line 'start' "API ready at $apiUrl"

    Start-Managed 'web' 'cmd.exe' @('/d', '/c', "npm run dev:poc -- --port $WebPort --strictPort") (Join-Path $root 'frontend')
    Write-Line 'start' "Open http://127.0.0.1:$WebPort/prototype.html. Press Ctrl+C to stop."

    $reported = @{}
    while ($true) {
        if (-not (Receive-Lines)) { Start-Sleep -Milliseconds 200 }
        foreach ($tag in @($processes.Keys)) {
            if ($processes[$tag].HasExited -and -not $reported[$tag]) {
                $reported[$tag] = $true
                Write-Line 'start' "$tag exited with code $($processes[$tag].ExitCode)"
            }
        }
        if ($reported.Count) { throw 'A process stopped; stopping the other one' }
    }
} finally {
    [void](Receive-Lines)
    foreach ($tag in @('web', 'api')) {
        $process = $processes[$tag]
        if ($process -and -not $process.HasExited) {
            Write-Host ('{0} [start] stopping {1}' -f (Get-Date -Format 'HH:mm:ss'), $tag) -ForegroundColor Gray
            # The whole tree: the uvicorn reloader and npm start child processes.
            try { $process.Kill($true) } catch {}
            try { [void]$process.WaitForExit(10000) } catch {}
        }
    }
    Get-EventSubscriber | Unregister-Event -ErrorAction SilentlyContinue
    Get-Event | Remove-Event -ErrorAction SilentlyContinue
}
