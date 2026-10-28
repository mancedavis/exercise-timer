@echo off
rem Builds dist\ExerciseTimer.exe (single file, no console window).
rem Needs native Windows Python 3 (python.org installer or the Microsoft Store build).
rem Usage: build.bat            run the tests, then build
rem        build.bat skip-tests build only
setlocal
cd /d "%~dp0"

if not exist .venv\Scripts\python.exe (
    where py >nul 2>nul && (py -3 -m venv .venv) || (python -m venv .venv)
)
if not exist .venv\Scripts\python.exe (
    echo Could not create .venv. Install Python 3 for Windows and try again.
    exit /b 1
)

.venv\Scripts\python.exe -m pip install --quiet -r requirements-dev.txt || goto :fail
if /i not "%~1"=="skip-tests" (
    .venv\Scripts\python.exe -m unittest discover -s tests -t . || goto :fail
)
.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onefile --windowed ^
    --name ExerciseTimer --distpath dist --workpath build\work --specpath build main.py || goto :fail

echo.
echo Built: %~dp0dist\ExerciseTimer.exe
for %%F in (dist\ExerciseTimer.exe) do echo Size: %%~zF bytes
exit /b 0

:fail
echo.
echo Build failed.
exit /b 1
