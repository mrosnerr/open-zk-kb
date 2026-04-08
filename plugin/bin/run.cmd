@echo off
REM Platform detection and binary selection for open-zk-kb MCP server (Windows)

set "SCRIPT_DIR=%~dp0"
set "BINARY=%SCRIPT_DIR%open-zk-kb-windows-x64.exe"

if not exist "%BINARY%" (
  echo Binary not found: %BINARY% >&2
  echo Available binaries: >&2
  dir /b "%SCRIPT_DIR%open-zk-kb-*" 2>nul >&2
  exit /b 1
)

"%BINARY%" %*
