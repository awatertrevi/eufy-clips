# Eufy Clips

Browse the motion events and **recorded clips** of an Eufy **HomeBase 2** (T8010) with eufyCam 2/2C cameras, from
Home Assistant or any browser.

Existing Home Assistant integrations can show live video and the latest event image, but not the clips the HomeBase
has stored on its own storage. Eufy Clips reads the HomeBase's event database over the same P2P connection the Eufy
app uses, downloads a clip when you press play, decrypts it and serves it as a normal MP4.

- Timeline of events per day with thumbnails and detection type (person, motion, …), filterable per camera
- Clips fetched on demand (typically 7–25 s the first time, instant from the cache afterwards)
- Several HomeBases (also in different houses) in one service, with a per-HomeBase view
- One small Node service, no cloud storage subscription needed

> Unofficial and not affiliated with Anker/Eufy. It relies on undocumented protocols that can change with any
> firmware or app update. Use a dedicated Eufy guest account.

## Tested with

| Device | Model | Notes |
| --- | --- | --- |
| HomeBase 2 | T8010, firmware 3.4.2.6h | local P2P and P2P over the internet |
| eufyCam 2C / 2C Pro | T8113 | 1920×1080, 15 fps, with audio |
| Video Doorbell (battery) | T8210 | 2048×1536 |
| Video Doorbell Dual | T8224 | recording on the HomeBase |

HomeBase 3 has its own protocol and is not supported (see [eufy-mega-security](https://github.com/mscodemonkey/eufy-mega-security)
for HomeBase 3). Standalone cameras without a HomeBase are not supported.

## How it works

| Step | Protocol (all over the HomeBase P2P session) |
| --- | --- |
| Event list | `CMD_SET_PAYLOAD 1350` → `CMD_DATABASE 1306` → `10017` on table `history_record_info`, with `start_date < end_date` and `start_time` as a newest-first cursor (`"0"` = newest). Rows carry `storage_path`, `thumb_path`, `cipher_id` and times; `record_crop_picture_info` carries the detection type. |
| Thumbnail | `CMD_DATABASE_IMAGE 1308` for `thumb_path`. The library substitutes a fixed 288×176 JPEG header; `src/thumbnail.mjs` recovers the real geometry and contrast. |
| Clip key | `cipher_id` has a flag in the high byte (`134217735` = `0x08000000 \| 7`); `get_ciphers([cipher_id & 0xffffff])` returns `ecc_private_key`. The RSA `private_key` in that response comes back lower-cased and is unusable. |
| Clip | `CMD_DOWNLOAD_VIDEO 1024` (path + account). Video `1300` keyframes (sign > 0) carry an ECIES-wrapped AES-256 media key and an AES-256-GCM payload; delta frames (sign 0) are clear. Audio `1301` is AES-256-GCM with the same media key and decrypts to ADTS AAC. See `src/decode.mjs`. |

Notes for anyone building on this:

- eufy-security-client cancels a download (`CMD_DOWNLOAD_CANCEL`) when *its* stream timer sees no data for 5 s. When
  you handle the frames yourself, refresh that timer (`session.waitForStreamData`) or long clips stop at ~2 MB.
- A cancelled download can keep arriving; only count frames whose P2P channel matches the camera's channel.
- The library only emits "download finished" for streams it handled itself, so completion is detected as "all
  `frame_num` frames received".
- All P2P work runs one task at a time with priorities (clip > thumbnail > sync), otherwise a clip waits behind
  the index sync and dozens of thumbnails.

The index syncs today/yesterday every few minutes and back-fills five older days per run (30 days by default).

## Install

Requires Node ≥ 22 and `ffmpeg`.

```sh
git clone https://github.com/awatertrevi/eufy-clips.git /opt/eufy-clips
cd /opt/eufy-clips && npm ci --omit=dev
sudo cp deploy/eufy-clips.env.example /etc/eufy-clips.env   # fill in, then: sudo chmod 600 /etc/eufy-clips.env
sudo useradd --system --home /var/lib/eufy-clips --create-home eufy-clips
sudo cp deploy/eufy-clips.service /etc/systemd/system/ && sudo systemctl enable --now eufy-clips
```

Or with Docker (host networking is needed for local P2P discovery):

```sh
docker build -t eufy-clips .
docker run -d --name eufy-clips --network host --env-file eufy-clips.env -v eufy-clips:/data eufy-clips
```

Open `http://<host>:8787/?token=<EUFY_CLIPS_TOKEN>`. On the first login Eufy mails a verification code; the page
shows a field to enter it. The session is kept in the data directory, so restarts do not ask again.

### Configuration

| Variable | Default | |
| --- | --- | --- |
| `EUFY_USERNAME` / `EUFY_PASSWORD` | – | Eufy account (use a guest account with only the home shared) |
| `EUFY_COUNTRY` | `NL` | account country |
| `EUFY_STATIONS` | all | comma-separated HomeBase 2 serials to include |
| `EUFY_CLIPS_TOKEN` | – | shared secret for the UI, ≥ 24 characters (`openssl rand -hex 24`) |
| `EUFY_CLIPS_PORT` / `EUFY_CLIPS_HOST` | `8787` / `0.0.0.0` | |
| `EUFY_CLIPS_DATA` | `./data` | event index, Eufy session and clip cache |
| `EUFY_CLIPS_SYNC_MINUTES` | `5` | |
| `EUFY_CLIPS_BACKFILL_DAYS` | `30` | |
| `EUFY_CLIPS_CACHE_MB` | `800` | clip cache budget (least recently used clips are removed) |

## Home Assistant

Add a dashboard with a single **Webpage** card in a panel view:

```yaml
views:
  - title: Clips
    type: panel
    cards:
      - type: iframe
        url: https://clips.example.com/?token=YOUR_TOKEN&station=T8010XXXXXXXXXXX
        aspect_ratio: 100%
```

- `station=` (comma-separated serials) limits the view to one HomeBase, handy when one service serves several houses.
- The token is passed on every request because, inside the Home Assistant iframe, the cookie is third-party and
  browsers do not send it.
- If you open Home Assistant over https (e.g. Nabu Casa), the iframe must be https too. A Cloudflare Tunnel is an
  easy way: `cloudflared tunnel create clips`, ingress `https://clips.example.com` → `http://localhost:8787`.
  Anyone with the URL *and* token can watch your clips, so keep the token secret (or add Cloudflare Access).

## API

All endpoints except `/healthz` need `?token=` (or the cookie set from it).

| Path | |
| --- | --- |
| `GET /` | UI |
| `GET /api/status` | session state (`connected`, `needs-2fa`, …), last sync, event counts |
| `POST /api/2fa` `{code}` / `POST /api/captcha` `{answer}` | finish an Eufy login |
| `GET /api/cameras?station=` | cameras on the configured HomeBases |
| `GET /api/events?station=&device=&before=&limit=` | newest-first event list |
| `GET /api/events/:id/thumb.jpg` / `clip.mp4` | fetched from the HomeBase on first request, then cached (Range supported) |
| `POST /api/sync` | sync now |

## Development

```sh
npm install
npm test
EUFY_CLIPS_DATA=./data node --env-file=.env src/main.mjs
```

## Credits

- [eufy-security-client](https://github.com/bropat/eufy-security-client) (MIT) for login, P2P and the HomeBase
  database commands. It is archived; its successor is [eufy-sdk](https://github.com/mega-yfue/eufy-sdk).
- [eufy-mega-security](https://github.com/mscodemonkey/eufy-mega-security) (MIT) for the ECC media-key format and
  the JPEG header recovery used in `src/thumbnail.mjs`.

## License

MIT
