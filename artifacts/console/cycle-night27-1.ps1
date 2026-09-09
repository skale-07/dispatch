Set-Location C:\dev\jobright-application-agent
$log = 'C:\dev\jobright-application-agent\artifacts\console\auto-cycle-2026-09-08-night27.log'
"=== cycle 1 start $(Get-Date -Format o) (fresh, max-apps 1, max-submits 1, app-deadline 300) ===" | Out-File $log -Append -Encoding utf8
npm run auto:cycle -- --no-update --headed --max-apps 1 --max-submits 1 --app-deadline 300 2>&1 | Out-File $log -Append -Encoding utf8
"=== cycle 1 end $(Get-Date -Format o) exit $LASTEXITCODE ===" | Out-File $log -Append -Encoding utf8
