@echo off
cd /d "%~dp0"
echo Starting local server for the NFL site...
start "" cmd /c "timeout /t 2 >nul && start http://localhost:8000/site/index.html"
python -m http.server 8000
if errorlevel 1 (
  echo.
  echo Python not found. Trying Node instead...
  npx --yes http-server -p 8000
)
pause
