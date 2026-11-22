# SyncSSH 1.0 — Trình khách SSH có đồng bộ WebDAV mã hóa

> [中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [Español](README.es.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

SyncSSH gộp SSH, SFTP, ghi chú Markdown và đồng bộ WebDAV mã hóa trong một ứng dụng. Hãy cấu hình máy chủ và jump host ở PC A rồi khôi phục ở PC B. 💗

## Tiếng Việt

Hỗ trợ SSH trực tiếp/một jump host, kiểm tra vân tay SHA-256, SFTP truyền/sửa/quyền, ghi chú ảnh/HTML, lịch sử Bash/Zsh, giám sát Linux, báo thức và giao diện sáng/đen-xanh.

## Download

Tải bản Windows x64 từ [Releases](../../releases), giải nén ZIP rồi chạy `SyncSSH.exe`. Không cần Node.js. Kho cục bộ: `%APPDATA%\\SyncSSH\\vault.json`.

## Setup and sync

Tạo mật khẩu chính ít nhất 12 ký tự. Trong **Cài đặt đồng bộ**, cấu hình WebDAV và tạo kho từ xa; ở PC thứ hai hãy khôi phục từ WebDAV. Cần `GET`, `PUT`, `MKCOL`, `PROPFIND`, `DELETE`, `MOVE`. Dữ liệu được mã hóa cục bộ bằng scrypt/AES-256-GCM trước khi đồng bộ. Chúc mọi kết nối thành công! 🚀

