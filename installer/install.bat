@echo off
title Mantis Installer
echo.
echo   Starting Mantis installer...
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
echo.
pause
