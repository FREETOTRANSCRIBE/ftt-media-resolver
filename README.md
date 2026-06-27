# FreeToTranscribe — media-resolver

Tiny service that turns a **TikTok / Instagram** link into audio and uploads it
to a presigned Cloudflare R2 URL. The FTT Cloudflare Worker (`/api/resolve-url`)
is the only caller; it authenticates with a shared secret. The browser never
calls this service directly.

> YouTube is **not** supported in v1 — in 2026 it blocks datacenter IPs, so it
> needs paid residential proxies. The code is structured so a `youtube` branch
> can be added later.

## Endpoints
- `GET  /health` → `{ ok: true }`
- `POST /resolve` (header `X-FTT-Secret: <RESOLVER_SECRET>`)
  - body `{ "url": "<tiktok|instagram link>", "uploadUrl": "<presigned R2 PUT>" }`
  - success `{ ok: true, durationSeconds, sizeMB }`
  - errors: `403 forbidden`, `422 unsupported_platform` / `unavailable`,
    `413 too_large`, `504 resolve_timeout`, `502 resolve_failed|upload_failed`

## Env
| var | default | notes |
|-----|---------|-------|
| `RESOLVER_SECRET` | — | **required**; must match the Worker's `MEDIA_RESOLVER_SECRET` |
| `PORT` | `8080` | listen port |
| `YTDLP_BIN` / `FFMPEG_BIN` / `FFPROBE_BIN` | binaries on PATH | override if needed |

## Run locally
```bash
cd media-resolver
npm install
RESOLVER_SECRET=devsecret node server.js
# needs yt-dlp + ffmpeg/ffprobe on PATH
```

## Deploy (Docker)
```bash
docker build -t ftt-media-resolver .
docker run -e RESOLVER_SECRET=$SECRET -p 8080:8080 ftt-media-resolver
```
Host on a free-tier always-on VM (e.g. Oracle Cloud Always Free) or a small VPS,
put it behind `media.freetotranscribe.com`, and set the Worker secrets
`MEDIA_RESOLVER_URL` (= `https://media.freetotranscribe.com`) and
`MEDIA_RESOLVER_SECRET` (= `RESOLVER_SECRET`).

Keep `yt-dlp` current (rebuild image or `yt-dlp -U` on a cron) — extractors
change over time.
