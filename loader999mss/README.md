# 999MS — loader, key API และแผงควบคุม

โปรเจกต์นี้คือ **ตัวล่าสุด** (`loader999mss-source-no-obf-txt`) ที่นำมาแทนของเดิมทั้งหมด
ทุก stage ที่ส่งให้ executor เป็น Lua ที่อ่านได้ ไม่ผ่าน obfuscator

## โครงสร้าง

```
api/auth.js          ตัวจัดการทุก route (Vercel function)
source/              ซอร์ส Lua ที่อ่านได้ของทุก stage + build.js
artifacts/           ผล build ที่เสิร์ฟจริง (สร้างด้วย `node source/build.js`)
scripts/main.lua     สคริปต์ปลายทางที่เสิร์ฟผ่าน /api/script
web/                 หน้าเว็บหลัก (/) และแผงควบคุม (/control)
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
| `/api/health` | สถานะระบบ (ไม่ต้อง auth) |
| `/loadc.lua` | stage 1 — render จาก template ทุก request |
| `/loada.lua/<d>/<n>` | stage 2 — ต้องมี capability อายุ 20 วิ |
| `/loader.lua` `/payload.lua` | stage 3–4 (Lua อ่านได้) |
| `/api/verify` `/api/script` `/api/script-verify` `/api/heartbeat` | flow คีย์ → ticket → runtime proof |
| `/api/control/sessions` `/api/control/command` `/api/control/bans` `/api/control/traffic` | API ของแผงควบคุม |

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

ทดสอบหลังแทนที่: `/loadc.lua` 1803 B (Lua อ่านได้) → `/loada.lua/<cap>` 8085 B (SHA-256 ตรง pin)
→ `/loader.lua` 20917 B → `/payload.lua` 30881 B · WS client ต่อ gateway ได้ · แผงควบคุมเห็น
session (`sessionId`, `idleMs`) และสั่ง `notice` ถึง client ได้จริง

จุดย้อนกลับ: tag `pre-source-package` และ `pre-no-websocket` ใน repo `whilstkey`

## Git → Vercel auto-deploy (เชื่อมแล้ว)

โปรเจกต์ `loader999mss` ผูกกับ repo **`rickhub940-ai/whilstkey`** สาขา `main` แล้ว
→ `git push origin main` = Vercel build + deploy production ให้เอง
(ยืนยันแล้ว: commit `7883553` ถูก build และขึ้น production โดยไม่ได้สั่ง deploy ด้วยมือ)

(Render deploy จาก repo นั้น)

## 2026-10-17 — แก้ "RNG integers rejected" ตอน Verify Key

สาเหตุ: `/api/verify` บังคับ RNG challenge แต่ payload ที่ deploy ส่ง RNG ไปกับ `/api/script`
(ฝั่งนั้นตรวจกับ `Data` envelope ที่ถอดรหัสแล้ว) → ผู้ใช้จริงเห็น error ก่อนคีย์ถูกตรวจ

แก้: gate ที่ `/api/verify` บังคับเฉพาะเมื่อคำขอมี field `Rng1..Rng5/RngFloat` จริง
(`challengeSupplied`) และตอบ `check` เฉพาะเมื่อคำนวณได้ — `/api/script` ยังตรวจ RNG เข้มเหมือนเดิม
เพิ่ม regression test ใน `test/api.test.js`

## สถานะปัจจุบัน — ไม่มี WebSocket แล้ว (2026-10-17)

ก่อนหน้านี้เคยมี realtime gateway (Render + WebSocket) ซึ่งแก้ปัญหา `MS9-41AC183F`
มาแล้ว 2 รอบ — ตอนนี้ถอดออกทั้งหมดแล้วตามคำขอ:

ระบบ realtime / WebSocket / gateway ถูกถอดออกทั้งหมด:
- client (`scripts/main.lua`) ไม่มีการต่อ socket, ไม่มี heartbeat, ไม่มี reconnect
- ไม่มี `/api/realtime-ticket`, `/api/realtime/*`, `/api/session-renew`, `/admin`
- แผงควบคุม `/control` เป็น HTTP ล้วน: health + bans + traffic
- ไม่มีบริการ Render / repo gateway ในระบบอีก
