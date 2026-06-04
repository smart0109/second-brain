@echo off
cd /d "C:\Users\manis\social-selling-v4.1\second-brain-app"
python deploy_to_github.py --message "deploy: update index.html with latest changes" --files "public/index.html" --signatures "crmApi,getDealBrand,loadFollowups,renderFollowups,toggleFuGroup,switchProdView,prodAssetsView" --base-path "C:\Users\manis\social-selling-v4.1\second-brain-app"
echo.
echo ========================================
echo Deploy complete. This window will close in 30 seconds.
echo ========================================
timeout /t 30
