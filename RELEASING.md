# GitHub v1.0 发布准备

公开仓库地址确定后，在 package.json 的 repository.url 填入 HTTPS GitHub 仓库地址。应用从该字段显示「关于」中的仓库链接。当前准备版本为 1.0，授权草案为 MIT，作者为 Wypum。

## 构建和验证

    npm ci
    npx install-electron
    npm test
    npm run test:desktop
    npm run package:win

打包会选择下一个全新的 dist 编号。也可用 npm run package:win -- dist3 指定新目录。已存在的目录会拒绝写入。首次从 0.1.0 升级的输出目录是 dist2。

用完整解压的便携包验证启动、旧仓库解锁、直连及跳板、WebDAV 同步和新机恢复。目视检查浅色和高对比度主题，并用实际 Linux 主机确认监控安装和 Bash、Zsh 接入。

## 发布清单

- 源码提交包含 src、test、scripts、package-lock.json、README.md、CHANGELOG.md、LICENSE 等工程文件。公开仓库里应只出现测试夹具凭据和合成数据。
- 确认 GitHub 仓库地址和 MIT 授权后，为通过验证的提交建立 v1.0 标签并创建 Release。
- 附件使用对应 dist 目录中的 Windows x64 ZIP 与 SHA256SUMS.txt。发布说明可采用 CHANGELOG.md 的 1.0 条目。
- 当前便携包为未签名 Windows 构建。完成发布签名后重新计算 ZIP 的校验值。
