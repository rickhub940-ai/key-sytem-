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

## ระบบลิงก์โหลดแบบ somtank (2026-10-17)

ลิงก์มี namespace สุ่มยาวของตัวเอง ไม่ใช้ชื่อคงที่อีกต่อไป:

```
https://<host>/x/<40 hex สุ่ม>?at=<exp base36>.<sig 32 ตัว>
```

- `POST /api/link` (ต้อง `x-admin-token`) → `{ url, line, sha256, stub, expiresAt, path, id }`
- `GET /x/<40 hex>?at=<token>` → เสิร์ฟ entry script ที่ **ไบต์คงที่ต่อลิงก์** จึง pin `sha256` ได้แบบ somtank
- token เป็น HMAC (stateless) หมดอายุตาม `hours` (1–8760) ไม่ต้องมีฐานข้อมูล
- entry script ต่อเข้า `/loadc.lua` บน host เดิม → chain เดิมทั้งหมด
- `LINK_SECRET` = ค่าสุ่มยาว 64 hex (ตั้งใน Vercel production แล้ว) ถ้าไม่มีจะใช้ `TICKET_SECRET`
- แผง `/control` มีการ์ด **สร้างลิงก์โหลด** + ปุ่มคัดลอก (ลิงก์ / บรรทัด executor / สคริปต์เต็ม)

## 2026-10-17 — marker ตรวจการเซฟซอร์สเป็นค่าสุ่มยาว

เดิม `source/savecheck.lua` (Stage 2) ฝัง `-- supper_Boom` ไว้ 2 ที่ (บรรทัดแรก + สตริงที่ใช้สแกน)

ตอนนี้เป็น token `__CHAIN_MARKER__` ที่ถูกแทนตอนเสิร์ฟด้วยค่า

```
MS9MARK_<64 hex>   ← HMAC_SHA256(secret, '999MS chain marker v1')
```

- secret = `LINK_SECRET` → `TICKET_SECRET`
- ค่าคงที่ทุก request/instance (ไฟล์ที่เซฟไว้รอบก่อนยังถูกจับได้รอบถัดไป) แต่เดาจากสคริปต์ไม่ได้
- Stage-1 pin sha256 ของ Stage 2 คำนวณ **หลัง** แทน marker แล้ว → hash ตรงเสมอ
- แต่ละ stage ที่เสิร์ฟไม่มี token ค้าง (`__CHAIN_MARKER__` ถูกแทนหมด)

## 2026-10-17 — marker ตรวจการเซฟซอร์ส = ค่าตายตัว (พร้อม obfuscate)

เปลี่ยนจาก `-- supper_Boom` เป็น **ตัวแปรค่าตายตัว** ชื่อกลาง ๆ ที่ไม่บ่งบอกหน้าที่:

```lua
local MN0 = "@BASE_URL@/x/6f2c9a84d1e07b35ac84f0d97c1e6b25a8d3f904"
...
local marker = MN0
```

- ไม่มีการแทนค่าตอนเสิร์ฟแล้ว (ไม่มี token `__CHAIN_MARKER__` / `MS9MARK_...` อีก)
- ไบต์ของ Stage 2 คงที่ทุก request → เอาโค้ดไป obfuscate ได้โดยไม่กระทบ hash pin
- เก็บ `local NEXT_LINK = ...` ไว้ **เหนือบล็อกที่จะ obfuscate** แล้ว obfuscate ส่วนที่เหลือ
- ค่าที่สแกนหา = ตัว literal ใน `NEXT_LINK` (มี `/x/<40 hex>` ฝังอยู่ จึงไม่ซ้ำกับโค้ดอื่น)

## 2026-10-17 — ยกเทคนิคจาก 3 references (hop chain / equation / HWID header / events)

อ้างอิง: ชุดบทความ whitelist ของ shiawase, `zoolah/Luasec`, `loris1337/Roblox-Whitelist-System`
เลือกมาเฉพาะข้อที่เข้ากับเชน Lua แบบอ่านออก (ไม่ใช้ `getrawmetatable`/`hookmetamethod`/`NfCrash`)

| เทคนิค | มาจาก | อยู่ที่ |
| --- | --- | --- |
| hop แบบใช้ครั้งเดียว ผูกกับ `jti` ของ ticket | Luasec, loris | `lib/999MS-server-sdk.js` (`issueHop`/`consumeHop`) |
| สมการ `A = 2x−32`, `B = 5x+256` แล้วตอบด้วย `Equate(x)` | loris (`equate`) | `/api/verify` → `/api/script` |
| HWID ต้องมากับ header ด้วย ไม่ตรงกับ body = ปฏิเสธ | Luasec (`hwidMiddleware`) | `x-ms999-hwid` |
| challenge RNG ที่ต้องกลับ transform ได้ | shiawase | มีอยู่แล้ว, ตอนนี้บังคับใช้ทั้ง verify และ script |
| ตัวนับขั้น (Step) ต้องครบก่อนโหลด body | Luasec (`JumpCounter`) | `source/payload.lua` |
| JSON decoder ของตัวเอง (เลี่ยง hook `JSONDecode`) | shiawase | `JsonDecode` / `EncodeJson` |
| event log + แบนมีวันหมดอายุ | loris (`blacklistedFor`) | `/api/control/events` + การ์ดใน `/control` |
| kick แบบ crash แทน `while true do end` | shiawase | มีอยู่แล้ว (`SecureCrash`) |

ลำดับطلب: `/api/verify` (ได้ `hop`, `A`, `B`) → `/api/script` (เผา hop, ตรวจสมการ, คืน `hop` ใหม่ในซองเข้ารหัส) → `/api/script-verify` (เผา hop ใบที่สอง)


## 2026-10-17 — ย่อทุก stage: ตัวแปร ≤ 2 ตัว, ไฟล์ละ 1 บรรทัด

`source/*.lua` ยังเป็นเวอร์ชันอ่านออกสำหรับแก้ไข แต่ `node source/build.js` จะย่อด้วย `luamin`
ก่อนเขียนลง `artifacts/`:

| stage | เดิม | ใหม่ | locals สูงสุด |
| --- | --- | --- | --- |
| loadc | 1,575 B | 1,033 B | 1 ตัว |
| loada | 8,176 B | 4,243 B | 2 ตัว |
| loader | 20,490 B | 11,188 B | 2 ตัว |
| payload | 38,102 B | 21,957 B | 2 ตัว |

ทุกไฟล์ที่เสิร์ฟเป็น **1 บรรทัด** และ local ทุกตัวยาวไม่เกิน 2 ตัวอักษร
(ชื่อ global/field ของ Roblox เช่น `game`, `GetService`, `MS999Chain` เปลี่ยนไม่ได้)

marker ยังเป็น literal ตายตัว: `local a="@BASE_URL@/x/6f2c…"` แล้วผู้ใช้ obfuscate ต่อได้ทั้งไฟล์

ตรวจว่าไม่มีการเปลี่ยนพฤติกรรม: `python3 e2e/ast_compare.py` เทียบ AST ของ source กับ artifact
(ลบชื่อ local/คอมเมนต์, canonical literal) → MATCH ทั้ง 4 ไฟล์
ส่วนต่างเดียวคือการตัดวงเล็บ `x + (v - 1)` → `x + v - 1` ซึ่งค่าตรงกัน (ทดสอบ 20k คู่)


## 2026-10-17 — 4 สแตก ลิงก์ต่อลิงก์ อายุ 10 วิ + obf WeAreDevs ทุกรอบ

```
/loadc.lua ──► /loada.lua/<token> ──► /loader.lua/<token> ──► /payload.lua/<token>
```

- ทุก request ของ `loadc` จะสร้าง **run ใหม่ 1 ชุด**: chain id + ลิงก์ 3 ใบ (loada, loader, payload)
  อายุ **10 วินาที** นับจากตอนออก และ **ใช้ได้ครั้งเดียวต่อ stage**
- โทเคนมีรูปแบบ `<chainId>.<stage>.<exp>.<hmac>` → ตรวจได้แบบ stateless
  (ยิงข้าม instance ของ Vercel ได้), ผูกกับ stage ของตัวเอง (เอา token ของ loader ไปเปิด payload ไม่ได้)
- แต่ละ stage **pin sha256 ของ stage ถัดไป** ไว้ในตัว และตรวจก่อน `loadstring`
- `loadc` ถูก **obfuscate ผ่าน API ของ wearedevs.net ทุกรอบ**
  (`POST /api/obfuscate` → โค้ดใหม่ทุกครั้ง) ถ้า API ตอบ 429 จะ retry แบบ backoff
  และถ้าล่มจริงจะ fallback ไป `lua-obfuscator` ในเครื่องเพื่อไม่ให้เชนขาด
  (ดูได้จาก header `x-999ms-obf: wearedevs|local|plain`)
- stages 2–4 ยังเป็น Lua อ่านออก บรรทัดเดียว ตัวแปร ≤2 ตัว ตามเดิม

### ไฟล์ใหม่
- `lib/chainlink.js` — ออก/ตรวจ/เผา token ของแต่ละ stage (HMAC, TTL 10 วิ, กัน replay)
- `lib/obfuscate.js` — เรียก WeAreDevs API + retry + fallback + วัดเวลาเพื่อชดเชยหน้าต่าง 10 วิ
- `source/loadc.template.lua` — รับ `__STAGE2_URL__` + `__STAGE2_SHA256__`
- `source/savecheck.lua`, `source/loader.lua` — รับ `@NEXT@` / `@NEXT_SHA@`
