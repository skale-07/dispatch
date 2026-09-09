Set-Location C:\dev\jobright-application-agent
$log = 'C:\dev\jobright-application-agent\artifacts\console\night27-job2-daylit-run4.log'
"=== job2 daylit run4 start $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8
npm run run -- --pipeline --app 7669acfe-23d5-4b42-8ce0-c930c2a3c51e --submit --headed --yes 2>&1 | Out-File $log -Append -Encoding utf8
"=== job2 daylit run4 end $(Get-Date -Format o) exit $LASTEXITCODE ===" | Out-File $log -Append -Encoding utf8
