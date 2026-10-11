@echo off
setlocal
set "plugin_node=node"
if exist "%~dp0tools\runtime\node.exe" set "plugin_node=%~dp0tools\runtime\node.exe"
"%plugin_node%" "%~dp0tools\desktop.mjs" edit %*
if errorlevel 1 pause
