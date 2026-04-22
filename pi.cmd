@echo off
REM Local convenience wrapper for the pi CLI.
REM Uses the workspace build output in packages/coding-agent/dist.

setlocal
node "%~dp0packages\coding-agent\dist\cli.js" %*
