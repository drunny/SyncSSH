# SyncSSH 1.0 — Cliente SSH con sincronización WebDAV cifrada

> [中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [Español](README.es.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

SyncSSH reúne SSH, SFTP, notas Markdown y sincronización WebDAV cifrada. Configura hosts y bastiones en un PC y restáuralos en otro. 💗

## Español

Funciones: SSH directo y un bastión, huellas SHA-256, SFTP con transferencia/edición/permisos, notas con imágenes y HTML, sincronización, historial Bash/Zsh, monitorización Linux, alarmas y temas claro/negro-verde.

## Download

Descarga Windows x64 desde [Releases](../../releases), extrae el ZIP y abre `SyncSSH.exe`. No requiere Node.js. Almacén local: `%APPDATA%\\SyncSSH\\vault.json`.

## Setup and sync

Crea una contraseña maestra de 12+ caracteres. En **Ajustes de sincronización** configura WebDAV y crea el repositorio remoto; en el segundo PC restaura desde WebDAV. Se requieren `GET`, `PUT`, `MKCOL`, `PROPFIND`, `DELETE` y `MOVE`. Los datos se cifran localmente con scrypt/AES-256-GCM. ¡Que cada conexión funcione! 🚀

