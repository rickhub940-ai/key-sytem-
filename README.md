# 999MS — source snapshot

คัดลอกมาจากโปรเจกต์ที่ deploy จริง (17 ต.ค. 2026)

| โฟลเดอร์ | ใช้ที่ไหน | บริการ |
|---|---|---|
| `loader999mss/` | Vercel | เว็บ + API + แผงควบคุม |
| `render-package/` | Render | realtime WebSocket gateway |
| `loader999mss-source-no-obf-txt.zip` | — | ทั้งโปรเจกต์ (มี `artifacts/` ครบ ต่างจาก zip เดิมที่ตัดออก) |

## deploy

```bash
# Vercel
cd loader999mss && npx vercel deploy --prod

# Render (WebSocket gateway)
cd render-package && npm ci && npm start   # or push to the Render-connected repo
```

## build chain (Lua)

```bash
cd loader999mss
node source/build.js     # source/*.lua -> artifacts/*.lua (Lua อ่านได้ ไม่ obfuscate)
npm test
```

## URLs

- https://loader999mss.vercel.app — landing + API
- https://loader999mss.vercel.app/control — แผงควบคุม client (ADMIN_TOKEN)
- https://loader999mss.vercel.app/admin — realtime dashboard
- wss://loader999mss-realtime.onrender.com/realtime — gateway
