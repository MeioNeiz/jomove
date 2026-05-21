@echo off
REM Wrapper for Windows Task Scheduler.
REM Runs `bun jomove.ts auto-scrape` from the repo root, appends to a
REM rotating-style log file (date-stamped per day).

set REPO=C:\Users\JacobMaschler\Documents\southrent
set BUN=C:\Users\JacobMaschler\.bun\bin\bun.exe
set LOGDIR=%REPO%\data\logs

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM Date-stamped log file (YYYY-MM-DD). One file per day.
for /f "tokens=2 delims==" %%I in ('wmic os get LocalDateTime /value ^| find "="') do set DT=%%I
set YEAR=%DT:~0,4%
set MONTH=%DT:~4,2%
set DAY=%DT:~6,2%
set HOUR=%DT:~8,2%
set MIN=%DT:~10,2%
set LOG=%LOGDIR%\auto-scrape-%YEAR%-%MONTH%-%DAY%.log

cd /d "%REPO%"

echo. >> "%LOG%"
echo === %YEAR%-%MONTH%-%DAY% %HOUR%:%MIN% === >> "%LOG%"
REM --no-archive: scheduled runs don't need per-run snapshots (DB is authoritative).
REM Run `bun jomove.ts archive --label NAME` manually if you ever want one.
"%BUN%" jomove.ts auto-scrape --no-archive >> "%LOG%" 2>&1

