# SyncSSH 1.0 — ไคลเอนต์ SSH พร้อมการซิงก์ WebDAV แบบเข้ารหัส

> [中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [Español](README.es.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

SyncSSH รวม SSH, SFTP, โน้ต Markdown และ WebDAV แบบเข้ารหัสไว้ในแอปเดียว ตั้งค่าโฮสต์และ jump host บนคอมพิวเตอร์ A แล้วกู้คืนบน B ได้เลย 💗

## ไทย

รองรับ SSH ตรง/ผ่าน jump host หนึ่งชั้น, ตรวจสอบลายนิ้วมือ SHA-256, SFTP โอน/แก้ไข/สิทธิ์, โน้ตภาพและ HTML, ประวัติ Bash/Zsh, มอนิเตอร์ Linux, นาฬิกาปลุก และธีมสว่าง/ดำเขียว.

## Download

ดาวน์โหลด Windows x64 จาก [Releases](../../releases), แตก ZIP ให้ครบ แล้วเปิด `SyncSSH.exe` ไม่ต้องใช้ Node.js. คลังข้อมูลในเครื่องคือ `%APPDATA%\\SyncSSH\\vault.json`.

## Setup and sync

สร้างรหัสผ่านหลักอย่างน้อย 12 ตัวอักษร ใน **การตั้งค่าการซิงก์** ตั้งค่า WebDAV และสร้างคลังระยะไกล; เครื่องที่สองให้กู้คืนจาก WebDAV. ต้องรองรับ `GET`, `PUT`, `MKCOL`, `PROPFIND`, `DELETE`, `MOVE`. ข้อมูลถูกเข้ารหัสในเครื่องด้วย scrypt/AES-256-GCM ก่อนซิงก์ ขอให้ทุกการเชื่อมต่อสำเร็จ! 🚀

