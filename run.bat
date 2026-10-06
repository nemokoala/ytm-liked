@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [setup] Creating virtual environment...
  python -m venv .venv || goto :fail
)
rem Installs any missing packages (e.g. after git pull). Fast when nothing changed.
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt || goto :fail
".venv\Scripts\python.exe" app.py
goto :eof

:fail
echo.
echo [error] Setup failed. Make sure Python 3.10+ is installed and on PATH.
pause
