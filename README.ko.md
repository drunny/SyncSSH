# SyncSSH 1.0 — WebDAV 암호화 동기화를 갖춘 SSH 클라이언트

> [中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [Español](README.es.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

SyncSSH는 SSH, SFTP, Markdown 서버 메모와 암호화된 WebDAV 동기화를 하나로 모은 클라이언트입니다. PC A의 호스트와 점프 서버 설정을 PC B에서 복원할 수 있습니다. 💗

## 한국어

직접 SSH/단일 점프 호스트, SHA-256 지문 확인, SFTP 전송·편집·권한, 이미지/HTML 메모, Bash/Zsh 기록, Linux 모니터링, 알람, 밝은/검정-초록 테마를 지원합니다.

## Download

[Releases](../../releases)에서 Windows x64 버전을 받고 ZIP을 완전히 푼 뒤 `SyncSSH.exe`를 실행하세요. Node.js는 필요 없습니다. 로컬 저장소는 `%APPDATA%\\SyncSSH\\vault.json`입니다.

## Setup and sync

첫 실행 시 12자 이상의 마스터 비밀번호를 만드세요. **동기화 설정**에서 WebDAV 원격 저장소를 만들고, 다른 PC에서는 WebDAV에서 복원합니다. `GET`, `PUT`, `MKCOL`, `PROPFIND`, `DELETE`, `MOVE`가 필요합니다. 동기화 전 데이터는 scrypt/AES-256-GCM으로 로컬 암호화됩니다. 모든 연결이 성공하길 바랍니다! 🚀

