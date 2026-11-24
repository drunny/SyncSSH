# GitHub 发布说明

应用从 package.json 的 repository.url 读取「关于」页的 GitHub 地址。当前准备版本为 1.2.0，使用 MIT 许可证，作者为 Wypum。

## 构建和验证

    npm ci
    npx install-electron
    npm test
    npm run test:desktop
    npm run package:win

打包目录按版本号命名。1.2.0 使用 dist1.2，补丁版本如 1.1.1 使用 dist1.1.1。已有目录会拒绝写入。

用完整解压的便携包验证启动、旧仓库解锁、直连及跳板、WebDAV 同步和新机恢复。目视检查浅色和高对比度主题，并用实际 Linux 主机确认监控安装和 Bash、Zsh 接入。

## 发布清单

- 源码提交包含 src、test、scripts、package-lock.json、README.md、CHANGELOG.md、LICENSE 等工程文件。公开仓库里应只出现测试夹具凭据和合成数据。
- 确认 GitHub 仓库地址和 MIT 授权后，为通过验证的提交建立 v1.1 标签并创建 Release。
- 附件使用对应 dist 目录中的 Windows x64 ZIP 与 SHA256SUMS.txt。发布说明可采用 CHANGELOG.md 的对应版本条目。
- 当前便携包为未签名 Windows 构建。完成发布签名后重新计算 ZIP 的校验值。

## 三平台自动构建

在各目标平台使用 npm run package:desktop。GitHub Actions 并行构建 Windows x64 ZIP、Ubuntu x64 DEB 和 Apple Silicon macOS 预览 DMG，并从成品运行测试。release/v* 分支用于验证，版本标签在通过验证后生成带 SHA-256 的 GitHub Release 草稿。

Ubuntu 正式支持以 24.04 LTS x64 为基准，并用同一个安装包检查 26.04 LTS。macOS 只提供 Apple Silicon 的 ad hoc 签名预览包。发布前在目标 Mac 上验证下载后的首次打开流程。
