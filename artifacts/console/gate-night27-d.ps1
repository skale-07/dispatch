$log = 'C:\dev\jobright-application-agent\artifacts\console\gate-2026-09-08-night27-d.log'
Set-Location C:\dev\jobright-application-agent
"gate start $(Get-Date -Format o) (maxWorkers=1, detached, box memory-starved)" | Out-File $log -Encoding utf8
npm run typecheck 2>&1 | Out-File $log -Append -Encoding utf8; "== typecheck exit $LASTEXITCODE ==" | Out-File $log -Append -Encoding utf8
npx vitest run --maxWorkers=1 2>&1 | Out-File $log -Append -Encoding utf8; "== test exit $LASTEXITCODE ==" | Out-File $log -Append -Encoding utf8
npm run check:forbidden 2>&1 | Out-File $log -Append -Encoding utf8; "== forbidden exit $LASTEXITCODE ==" | Out-File $log -Append -Encoding utf8
npm run check:secrets 2>&1 | Out-File $log -Append -Encoding utf8; "== secrets exit $LASTEXITCODE ==" | Out-File $log -Append -Encoding utf8
"gate end $(Get-Date -Format o)" | Out-File $log -Append -Encoding utf8
