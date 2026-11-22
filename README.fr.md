# SyncSSH 1.0 — Client SSH avec synchronisation WebDAV chiffrée

> [中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [Español](README.es.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

SyncSSH réunit SSH, SFTP, notes Markdown et synchronisation WebDAV chiffrée. Configurez vos hôtes, bastions et chemins sur un PC, puis restaurez-les sur un autre. 💗

## Français

Fonctions : SSH direct et bastion unique, vérification SHA-256, SFTP (transfert, édition, permissions), notes avec images/export HTML, synchronisation, historique Bash/Zsh, surveillance Linux, alarmes et thèmes clair/noir-vert.

## Download

Téléchargez la version Windows x64 depuis [Releases](../../releases), extrayez le ZIP puis lancez `SyncSSH.exe`. Aucun Node.js n’est requis. Le coffre local est `%APPDATA%\\SyncSSH\\vault.json`.

## Setup and sync

Créez un mot de passe maître de 12 caractères ou plus. Dans **Paramètres de synchronisation**, configurez WebDAV et créez le dépôt distant ; sur le second PC, choisissez la restauration WebDAV. WebDAV doit accepter `GET`, `PUT`, `MKCOL`, `PROPFIND`, `DELETE` et `MOVE`. Les données sont chiffrées localement avec scrypt/AES-256-GCM. Que vos connexions réussissent ! 🚀

