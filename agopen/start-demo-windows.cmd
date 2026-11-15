@echo off
rem Windows launcher for the live demo with stand-in vehicles (no AgOpenWeb). See start-demo-windows.ps1.
rem Runs the PowerShell script for this launch only; it does not change your execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-demo-windows.ps1" %*
