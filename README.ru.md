# SyncSSH 1.0 — SSH-клиент с зашифрованной синхронизацией WebDAV

> [中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [Español](README.es.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

SyncSSH объединяет SSH, SFTP, Markdown-заметки и зашифрованную синхронизацию WebDAV. Настройте серверы и bastion на одном ПК, затем восстановите их на другом. 💗

## Русский

Возможности: прямой SSH и один jump-host, SHA-256 отпечатки, SFTP с передачей/редактированием/правами, заметки с изображениями и HTML, синхронизация, история Bash/Zsh, мониторинг Linux, будильники и светлая/чёрно-зелёная темы.

## Download

Скачайте Windows x64 с [Releases](../../releases), распакуйте ZIP и запустите `SyncSSH.exe`. Node.js не нужен. Хранилище: `%APPDATA%\\SyncSSH\\vault.json`.

## Setup and sync

Создайте мастер-пароль из 12+ символов. В **Настройках синхронизации** настройте WebDAV и создайте удалённый репозиторий; на втором ПК выберите восстановление WebDAV. Нужны `GET`, `PUT`, `MKCOL`, `PROPFIND`, `DELETE`, `MOVE`. Данные шифруются локально scrypt/AES-256-GCM. Удачных подключений! 🚀

