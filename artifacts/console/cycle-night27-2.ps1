Set-Location C:\dev\jobright-application-agent
$log = 'C:\dev\jobright-application-agent\artifacts\console\auto-cycle-2026-09-08-night27.log'
"=== cycle 2 start $(Get-Date -Format o) (backlog, max-apps 1, max-submits 1, app-deadline 300) ===" | Out-File $log -Append -Encoding utf8
npm run auto:cycle -- --backlog --no-update --headed --max-apps 1 --max-submits 1 --app-deadline 300 2>&1 | Out-File $log -Append -Encoding utf8
"=== cycle 2 end $(Get-Date -Format o) exit $LASTEXITCODE ===" | Out-File $log -Append -Encoding utf8
