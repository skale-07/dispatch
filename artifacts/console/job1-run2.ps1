Set-Location C:\dev\jobright-application-agent
$log = 'C:\dev\jobright-application-agent\artifacts\console\night27-job1-coinbase-run2.log'
"=== job1 coinbase run2 start $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8
npm run run -- --pipeline --app 79e75805-29ca-4829-b144-b75c5ea334ef --submit --headed --yes 2>&1 | Out-File $log -Append -Encoding utf8
"=== job1 coinbase run2 end $(Get-Date -Format o) exit $LASTEXITCODE ===" | Out-File $log -Append -Encoding utf8
