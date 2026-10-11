@echo off
setlocal
set "plugin_node=node"
if exist "%~dp0tools\runtime\node.exe" set "plugin_node=%~dp0tools\runtime\node.exe"
chcp 65001 >nul
"%plugin_node%" "%~dp0tools\desktop.mjs" status %*
set "plugin_exit=%errorlevel%"
echo.
pause
exit /b %plugin_exit%
