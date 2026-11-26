@echo off
REM cloudcli 开机自启：恢复 pm2 托管的服务
REM 用脚本自身所在目录，换机器/换盘符不用改路径
cd /d "%~dp0"
call pm2 resurrect
exit
