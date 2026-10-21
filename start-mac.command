#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先访问 https://nodejs.org 安装 LTS 版本，然后重新双击此文件。"
  read -p "按回车退出…"
  exit 1
fi
IP=$(ipconfig getifaddr en0 2>/dev/null)
echo "=========================================="
echo "🎤 声份谜局 已启动"
echo "电脑浏览器： http://localhost:3000"
if [ -n "$IP" ]; then
  echo "同 Wi-Fi 手机： http://$IP:3000"
fi
echo "请保持这个终端窗口打开，游戏服务器才会运行。"
echo "=========================================="
node server.js
read -p "服务器已停止，按回车退出…"