# SyncSSH 1.0 — SSH Client with Encrypted WebDAV Sync

> [中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [Español](README.es.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

> Many SSH clients exist; SyncSSH wants to be the considerate one that carries your server setup with you. 💗

SyncSSH is an SSH client built around sync from day one. Configure hosts, jump servers, SFTP paths, and notes on computer A; computer B should not make you repeat that memory-adventure quest. 😵‍💫 SSH, SFTP, Markdown server notes, and encrypted WebDAV sync live in one desktop app, with an alarm and visible clock for people who lose track of time in terminals.

## Features

- Direct SSH and one-hop jump hosts with SHA-256 fingerprint verification
- SFTP browsing, upload/download, editing, renaming, deletion, path copying, and permissions
- Markdown notes with images, preview, HTML export, and terminal-selection append
- Encrypted WebDAV sync for restoring server data on another computer
- Terminal copy/reconnect/clear, multiline commands, Bash/Zsh history, timers, alarms, and breaks
- Linux CPU/memory/disk/network monitoring; light and black-green themes 🟩

## Download and start

Download the Windows x64 portable build from [Releases](../../releases), extract it completely, then run `SyncSSH.exe`. Node.js is not needed; copy the whole folder to another Windows x64 computer. The local encrypted vault is `%APPDATA%\SyncSSH\vault.json`.

> The portable build is unsigned. Verify the download came from this repository’s Release page if Windows warns you.

## First use and WebDAV sync

Create a master password of at least 12 characters on first launch. It encrypts local data and is independent from SSH and WebDAV passwords. Add a host, port, user, password or exportable private key, group, location, and notes. Save a reachable jump-host connection first when needed, and verify the SHA-256 fingerprint on first connection.

SyncSSH encrypts locally before syncing through WebDAV; the remote side sees only repository metadata, randomized revision names, sizes, and access times. On the first PC open **Sync settings**, enter WebDAV credentials, create a remote repository, enter the master password, and save. On the second PC choose **Restore from WebDAV** and use the same credentials and master password. Recheck SSH fingerprints on the new device.

WebDAV needs `GET`, `PUT`, `MKCOL`, `PROPFIND` (Depth 1), `DELETE`, and `MOVE` with `Overwrite: F`; HTTPS and preserving the `Destination` header are recommended.

## SFTP, notes, monitoring, and source

SFTP supports root browsing, files/folders, transfer, permissions, filtering, and UTF-8 text editing up to 2 MiB; directory downloads skip symlinks and Windows-incompatible names. Notes support images, preview, HTML export, and terminal text. Linux metrics use a verified SSH channel with no extra ports; scripts live in `~/.SyncSSH` or `/root/.SyncSSH`.

Node.js 22.12+ source workflow:

```bash
npm ci
npx install-electron
npm start
npm test
npm run test:desktop
npm run package:win
```

Vaults use scrypt-derived keys and AES-256-GCM. Password recovery/change and history compaction are not available yet. macOS and Linux clients, plus feedback-driven fixes, are next. May every connection succeed and every fingerprint match. 🚀
