@echo off
chcp 65001 >nul
echo === Second Brain Git Deploy ===
cd /d "C:\Users\manis\social-selling-v4.1\second-brain-app"

echo Step 1: Pull latest from GitHub (merge others' changes)...
git pull origin main --no-edit
if errorlevel 1 (
    echo MERGE CONFLICT - resolve manually then retry
    exit /b 1
)

echo Step 2: Stage all changes...
git add -A

echo Step 3: Check if anything to commit...
git diff --cached --quiet
if errorlevel 1 (
    echo Step 4: Committing...
    git commit -m "deploy: %date% %time:~0,8% via Cowork"
    echo Step 5: Pushing to GitHub...
    git push origin main
    if errorlevel 1 (
        echo PUSH FAILED - someone pushed while we were committing, retrying...
        git pull origin main --no-edit
        git push origin main
    )
    echo DEPLOY SUCCESS
) else (
    echo Nothing to deploy - local matches GitHub
)
