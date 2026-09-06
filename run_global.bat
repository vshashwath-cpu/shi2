@echo off
title GeoAI Cadastral Workstation - Global Server
echo =========================================================================
echo    AI-BASED AUTOMATED URBAN PARCEL MAPPING ^& CADASTRAL FEATURE EXTRACTION
echo                  Global Internet Deployment (Cloudflare Tunnel)
echo =========================================================================
echo.

REM Start the local Python server in a minimized window
echo [1/2] Starting local GeoAI server on port 5000...
start /min "GeoAI Backend Server" python run_server.py

REM Wait 3 seconds for server to initialize
timeout /t 3 /nobreak > nul

REM Start Cloudflare Tunnel to expose the server globally with free HTTPS
echo [2/2] Launching Cloudflare Global Tunnel...
echo.
echo =========================================================================
echo  Your global HTTPS link will appear below in a few seconds.
echo  Share that link with anyone in the world to access your workstation!
echo =========================================================================
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://127.0.0.1:5000
pause
