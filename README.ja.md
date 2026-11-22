# SyncSSH 1.0 — WebDAV 暗号化同期対応 SSH クライアント

> [中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [Español](README.es.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

SyncSSH は SSH、SFTP、Markdown メモ、暗号化 WebDAV 同期を一つにまとめたクライアントです。PC A で設定したホストや踏み台を PC B に復元できます。💗

## 日本語

直接 SSH・1 段踏み台、SHA-256 フィンガープリント確認、SFTP 転送/編集/権限、画像付きメモと HTML 出力、Bash/Zsh 履歴、Linux 監視、アラーム、ライト/黒緑テーマに対応します。

## Download

[Releases](../../releases) から Windows x64 版を取得し、ZIP を展開して `SyncSSH.exe` を起動してください。Node.js は不要です。ローカル保管先は `%APPDATA%\\SyncSSH\\vault.json` です。

## Setup and sync

初回起動時に 12 文字以上のマスターパスワードを作成します。**同期設定** で WebDAV を設定してリモートリポジトリを作成し、別 PC では WebDAV から復元します。`GET`、`PUT`、`MKCOL`、`PROPFIND`、`DELETE`、`MOVE` が必要です。データは同期前に scrypt/AES-256-GCM でローカル暗号化されます。接続成功を祈ります！🚀

