@echo off
title Create Clean Offline Zip
echo ========================================================
echo Creating a clean Zip archive for offline transfer...
echo This will exclude .git and node_modules to save space
echo and make copying to USB extremely fast!
echo ========================================================
echo.

set ZIP_PATH=Ahwr-50-Twin_offline.zip

if exist "%ZIP_PATH%" (
    echo Deleting existing offline zip...
    del "%ZIP_PATH%"
)

echo Packaging files... (This may take 1-2 minutes)
tar -a -c -f "%ZIP_PATH%" --exclude="frontend/node_modules" --exclude=".git" --exclude="frontend/dist" --exclude="Create_Offline_Zip.bat" --exclude="%ZIP_PATH%" .

echo.
echo ========================================================
echo SUCCESS! Zip file created successfully!
echo Location: C:\Ahwr-50-Twin_offline.zip
echo.
echo You can copy this SINGLE file to your pendrive.
echo It is much faster than copying the folder directly.
echo ========================================================
echo.
pause
