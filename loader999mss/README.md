# 999MS — loader, key API และแผงควบคุม

โปรเจกต์นี้คือ **ตัวล่าสุด** (`loader999mss-source-no-obf-txt`) ที่นำมาแทนของเดิมทั้งหมด
ทุก stage ที่ส่งให้ executor เป็น Lua ที่อ่านได้ ไม่ผ่าน obfuscator

## โครงสร้าง

```
api/auth.js          ตัวจัดการทุก route (Vercel function)
lib/                 ticket / platoboost / revoke / realtime-ticket / server-sdk
source/              ซอร์ส Lua ที่อ่านได้ของทุก stage + build.js
artifacts/           ผล build ที่เสิร์ฟจริง (สร้างด้วย `node source/build.js`)
scripts/main.lua     สคริปต์ปลายทางที่เสิร์ฟผ่าน /api/script
web/                 หน้าเว็บหลัก (/) และแผงควบคุม (/control)
admin/               แดชบอร์ด realtime (/admin)
server.js            รัน local ได้เหมือน Vercel
test/api.test.js     ทดสอบ endpoint
```

## Build + test

```bash
node source/build.js     # source/*.lua -> artifacts/*.lua
npm test                 # ทดสอบ API (ไม่ต้องมี network)
```

## รันlocal

```bash
cp .env.example .env     # เติมค่า secret
PORT=10000 node server.js
```

## Routes

| Path | หน้าที่ |
|---|---|
| `/` | หน้าเว็บหลัก (landing) |
| `/control` | แผงควบคุม client (ต้อง `ADMIN_TOKEN`) |
| `/admin` | แดชบอร์ด realtime ของแพ็กเกจ |
| `/api/health` | สถานะระบบ (ไม่ต้อง auth) |
| `/loadc.lua` | stage 1 — render จาก template ทุก request |
| `/loada.lua/<d>/<n>` | stage 2 — ต้องมี capability อายุ 20 วิ |
| `/loader.lua` `/payload.lua` | stage 3–4 (Lua อ่านได้) |
| `/api/verify` `/api/script` `/api/script-verify` `/api/heartbeat` | flow คีย์ → ticket → runtime proof |
| `/api/realtime-ticket` | ออก ticket ให้ client ต่อ WebSocket gateway |
| `/api/realtime/sessions` `/api/realtime/command` | proxy ไป gateway (ต้อง `ADMIN_TOKEN`) |
| `/api/control/sessions` `/api/control/command` `/api/control/bans` `/api/control/traffic` | API ของแผงควบคุม |
| `/api/admin/ban` | แบน `hwid` / `hwidHash` / `user` / `ip` |

## หมายเหตุ
- `@BASE_URL@` ใน source ถูกแทนด้วย host ที่ executor เรียกเข้ามาจริง (ทำงานบน preview/โดเมนใหม่ได้)
- Stage 1 pin SHA-256 ของ Stage 2 ที่ render แล้ว
- UA trap ของ artifact เป็น opt-in: `TRAP_BROWSER_ARTIFACTS=1`

---

## สถานะปัจจุบัน (2026-10-17)

ตัวนี้คือตัวที่ใช้แทน **ทุกเวอร์ชันก่อนหน้า** แล้ว (ทั้ง `whilstkey` เดิม และ gateway รุ่นเก่า)

| บริการ | ที่อยู่ | เวอร์ชัน |
|---|---|---|
| เว็บ + API | https://loader999mss.vercel.app | 3.0.0 (source-only) |
| แผงควบคุม | https://loader999mss.vercel.app/control | — |
| แดชบอร์ด realtime | https://loader999mss.vercel.app/admin | — |
| Realtime gateway | https://loader999mss-realtime.onrender.com | 1.2.0 |

ทดสอบหลังแทนที่: `/loadc.lua` 1803 B (Lua อ่านได้) → `/loada.lua/<cap>` 8085 B (SHA-256 ตรง pin)
→ `/loader.lua` 20917 B → `/payload.lua` 30881 B · WS client ต่อ gateway ได้ · แผงควบคุมเห็น
session (`sessionId`, `idleMs`) และสั่ง `notice` ถึง client ได้จริง

จุดย้อนกลับ: tag `pre-source-package` ใน repo `whilstkey` และ `loader999mss-realtime`
