@echo off
setlocal enabledelayedexpansion
title CMake Link Explorer installer

echo.
echo   CMake Link Explorer
echo   ===================
echo.

rem ---------------------------------------------------------------- VS Code
rem Each check is its own line on purpose: %ProgramFiles(x86)% carries a ")"
rem that would close a parenthesised if/for block early.
rem
rem Code.exe is located directly rather than trusting `code` on PATH. A fresh
rem install leaves the terminal holding the PATH it started with, so `code`
rem often is not there yet even though VS Code is.
set "VSCODE="
if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" set "VSCODE=%LOCALAPPDATA%\Programs\Microsoft VS Code"
if not defined VSCODE if exist "%ProgramFiles%\Microsoft VS Code\Code.exe" set "VSCODE=%ProgramFiles%\Microsoft VS Code"
if not defined VSCODE if exist "%ProgramFiles(x86)%\Microsoft VS Code\Code.exe" set "VSCODE=%ProgramFiles(x86)%\Microsoft VS Code"

if not defined VSCODE (
  echo   VS Code was not found in any of the usual places.
  echo   Install VS Code first, then run this again.
  goto :stop
)
echo   VS Code   : !VSCODE!

rem ------------------------------------------------------------------- VSIX
set "VSIX="
set "VSIXNAME="
for %%f in ("%~dp0*.vsix") do (
  set "VSIX=%%~ff"
  set "VSIXNAME=%%~nf"
)
if not defined VSIX (
  echo   No .vsix file sits next to this script.
  echo   Keep install.cmd and the .vsix in the same folder.
  goto :stop
)
echo   Package   : !VSIXNAME!.vsix
echo.

echo   Installing the extension...
call "!VSCODE!\bin\code.cmd" --install-extension "!VSIX!" --force
if errorlevel 1 (
  echo.
  echo   The extension failed to install.
  goto :stop
)

echo.
echo   Done. Quit VS Code completely and start it again.
echo.
echo   It wakes up on its own when you open a CMake project or a C/C++ file,
echo   and finds the build directory by looking for CMakeCache.txt.
echo.
pause
exit /b 0

:stop
echo.
pause
exit /b 1
