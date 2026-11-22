# SyncSSH 1.0 - 带有 WebDAV 加密同步功能的 SSH 客户端

> [中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [Español](README.es.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

> SSH 客户端千千万，能把你的服务器资料一起带着走的，SyncSSH 想当其中那个更贴心的。💗

大家好，SyncSSH 是一个 SSH 客户端。顾名思义，它诞生之初的设计重点就是“同步”。👌 在电脑 A 配好服务器、跳板机、SFTP 路径和备忘录，换到电脑 B 后不必重新经历复制粘贴、翻聊天记录、找旧截图的“记忆力大冒险”。😵‍💫

SyncSSH 把 SSH、SFTP、服务器备忘录和 WebDAV 加密同步放进同一个桌面应用。我还加了闹钟和醒目的当前时间提醒，因为我经常对着 SSH 页面就忘记了时间。快乐是我们的精神食粮，少配一次 SSH 就多快乐一点。✨ヽ(´▽`)ﾉ Yes~ ✨

![Windows](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows) ![Version](https://img.shields.io/badge/version-1.0-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![WebDAV](https://img.shields.io/badge/WebDAV-encrypted-orange)

## 它能做什么？

- SSH 直连与单跳跳板机连接；核对 SHA-256 主机指纹
- SFTP 浏览、上传下载、编辑、重命名、删除、复制路径与权限设置
- Markdown 服务器备忘录：图片、预览、HTML 导出和终端选区追加
- WebDAV 加密同步，在多台电脑间恢复服务器资料
- 终端复制、重连、清屏、多行命令、Bash / Zsh 会话历史
- Linux 主机状态监控、连接计时、闹钟和周期休息提醒
- 白色主题与“纯黑绿字”主题 🟩

## 下载与启动

Windows x64 便携版在 [Releases](../../releases) 页面下载。完整解压 ZIP 后双击 `SyncSSH.exe`，无需安装 Node.js，整个文件夹可以直接复制到另一台 Windows x64 电脑。

> 当前便携版未签名。Windows 弹出安全提示时，请确认下载来源确实是本仓库的 Release。

本地加密仓库默认保存在 `%APPDATA%\SyncSSH\vault.json`。

## 第一次使用

![8fqSZkRc3M6SMrLtDpaywVjTBlpWEoU9.webp](https://cdn.nodeimage.com/i/8fqSZkRc3M6SMrLtDpaywVjTBlpWEoU9.webp)

首次启动时设置至少 12 个字符的主密码；它用于加密本地资料，不是 SSH 或 WebDAV 密码，请认真保管。

点击“新建连接”，填写服务器地址、端口、SSH 用户名、密码或可导出的 SSH 私钥，以及分组、所在地和备注。需要跳板机时，先保存可直连的跳板连接，再在目标服务器中选择它。首次连接请核对 SHA-256 主机指纹；指纹变化时先确认服务器确实轮换了密钥。

## WebDAV 加密同步

![AqNZn8dSVxspsyBCLlXAgLW0yC6SXIw8.webp](https://cdn.nodeimage.com/i/AqNZn8dSVxspsyBCLlXAgLW0yC6SXIw8.webp)

SyncSSH 先在本地加密，再通过 WebDAV 同步。远端只能看到仓库标识、随机修订文件名、大小和访问时间；服务器资料、密码、私钥和备忘录内容都经过加密保护。

第一台电脑：打开“同步设置”，填写 WebDAV 地址、账号和密码，选择“创建新的远程仓库”，输入主密码并保存同步。SyncSSH 会创建 `syncssh-v1` 子目录。

第二台电脑：首次启动选择“从 WebDAV 恢复”，填写相同的 WebDAV 信息和主密码。同步的是资料，不是安全直觉；新电脑上仍请重新核对主机指纹。

WebDAV 需要支持 `GET`、`PUT`、`MKCOL`、`PROPFIND`（Depth 1）、`DELETE` 和带 `Overwrite: F` 的 `MOVE`。建议 HTTPS，反向代理需要保留 `Destination` 请求头。

## SFTP、备忘录与监控

![mzkF7q6NIvJQUyz3ehJEl0JxOlXmEXqo.webp](https://cdn.nodeimage.com/i/mzkF7q6NIvJQUyz3ehJEl0JxOlXmEXqo.webp)

![7rqJFRRjKzfUiQLyURyLZucPRXgTOXw3.webp](https://cdn.nodeimage.com/i/7rqJFRRjKzfUiQLyURyLZucPRXgTOXw3.webp)

SFTP 支持根目录、新建文件/文件夹、传输、重命名、权限、过滤和不超过 2 MiB 的 UTF-8 文本编辑；目录下载会跳过符号链接和 Windows 不兼容文件名。保存前会检查远端是否已被他人修改，文明运维，从我做起。

每台服务器可保存 Markdown 备忘录：部署命令、域名、故障处理、SQL 和“这个服务为什么不能碰”的祖传警告。支持图片、预览、HTML 导出与终端文本追加。

Linux 监控经已验证 SSH 通道采集 CPU、内存、磁盘、网络/磁盘 I/O 和系统时间，无需额外端口；脚本保存在 `~/.SyncSSH` 或 `/root/.SyncSSH`。

## 从源码运行与安全

需要 Node.js 22.12 或更高版本：

```bash
npm ci
npx install-electron
npm start
npm test
npm run test:desktop
npm run package:win
```

本地仓库与远端修订使用 scrypt 派生密钥和 AES-256-GCM 加密；指纹按设备保存。目前不支持主密码找回、改密和历史压缩。当前版本支持单跳跳板机、Windows x64 和不超过 2 MiB 的 UTF-8 SFTP 编辑。

## 下版本计划

- 增加 macOS 与 Linux 客户端
- 根据用户建议修复 Bug、持续完善

牢记使命，不忘初心。如果 SyncSSH 能帮你少配一次服务器、少翻一次聊天记录、少经历一次“密码到底在哪”的灵魂拷问，那这就是我的初心。愿你的连接永远成功，主机指纹永远对得上。🚀

[GitHub 发布说明](RELEASING.md) · [变更记录](CHANGELOG.md) · [MIT 许可证](LICENSE)
