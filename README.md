# Eufy Clips

Browse the motion events and **recorded clips** of an Eufy **HomeBase 2** (T8010) with eufyCam 2/2C cameras, from
Home Assistant or any browser.

Existing Home Assistant integrations can show live video and the latest event image, but not the clips the HomeBase
has stored on its own storage. Eufy Clips reads the HomeBase's event database over the same P2P connection the Eufy
app uses, downloads a clip when you press play, decrypts it and serves it as a normal MP4.

- Timeline of events per day with thumbnails and detection type (person, motion, …), filterable per camera
- Clips of the last 7 days are prefetched in the background and play instantly; older clips are fetched on demand
  (typically 7–25 s the first time, instant from the cache afterwards)
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
| Indoor Cam Pan & Tilt 2K | T8410, firmware 2.3.2.6 | standalone, recordings on its own SD card; clips come from RTSP (see below) |

HomeBase 3 has its own protocol and is not supported (see [eufy-mega-security](https://github.com/mscodemonkey/eufy-mega-security)
for HomeBase 3).

### Wired cameras (T8410)

A wired Indoor Cam is its own station: it answers the same database and thumbnail commands, so its event list
and thumbnails work exactly like a HomeBase camera's. Its **clips cannot be decrypted**. Every keyframe of a
recording carries a 128-byte RSA-wrapped media key, and the matching private key is not the station cipher the
account hands out: `get_ciphers` answers an empty set for the `cipher_id 1` these rows carry, over both the v2
and the v3 endpoint. The app plays the same recordings, so it holds that key already, and it never sends one to
the camera — a playback request (`CMD_RECORD_VIEW 1025`) yields byte-identical keyframes to a plain download.

So the clip comes from the camera's RTSP stream instead. The service switches RTSP on, records every wired
camera continuously into clock-aligned 30-second MPEG-TS segments, and cuts a clip out of that archive when
one is asked for. The container matters: a recorder killed mid-segment leaves a readable TS file, while an
MP4 without its closing index cannot be opened at all and fails every cut that touches it. The event index and thumbnails still come from the camera.

The archive has holes: a camera drops off the wifi, the Pi loses its network for a night, a recorder is
restarted. Those holes are found before the cut rather than during it, because a concat across one fails
outright, and an empty segment (ffmpeg opens the next file before it has anything to write, so a kill at that
moment leaves one of zero bytes) is left out of every cut. An event with no video at all is marked "no clip"
in the UI; an event the recorder caught only part of yields the longest unbroken run it does have.

A camera can also go quiet without its recorder noticing — the wifi congests, or something else takes the
single RTSP slot the camera serves — and ffmpeg then waits instead of exiting. A watchdog restarts a recorder
that has written nothing for 90 seconds, and a camera that keeps refusing is retried with a growing delay
instead of every five seconds.

A T8410 also drops its RTSP server now and then without saying so: the `rtspStream` property still reports
"on" while every request is answered with 404, and no amount of reconnecting brings it back. A refused
recorder therefore asks for the switch to be turned off and on again over P2P (at most once every two
minutes) instead of only retrying the connection.

Budget roughly 11 GB per camera per day (1080p15 H.264 plus 16 kHz mono AAC); `EUFY_CLIPS_WIRED_DAYS` and
`EUFY_CLIPS_WIRED_MAX_GB` bound it, and `EUFY_CLIPS_WIRED_DIR` should point at a disk that can take it.
Set `EUFY_CLIPS_WIRED_DAYS=0` to leave wired cameras as an index with thumbnails only.

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
- A service that loses its network repeats the same failure endlessly: one outage produced 222,757 identical
  `send ENETUNREACH` lines, which filled the journal and pushed out the kernel messages that said why the wifi
  had gone. `src/log.mjs` writes the first occurrence and then only a count per minute.
- The library only emits "download finished" for streams it handled itself, so completion is detected as "all
  `frame_num` frames received".
- All P2P work runs one task at a time with priorities (clip > thumbnail > sync), otherwise a clip waits behind
  the index sync and dozens of thumbnails.

The index syncs today/yesterday every few minutes and back-fills five older days per run (30 days by default).

After each sync, clips and thumbnails of the last `EUFY_CLIPS_PREFETCH_DAYS` days are downloaded in the background,
newest first. Prefetching only starts P2P work when the queue is empty, so a clip you click waits for at most the
one download already running. It stops when the cache is at 90 % of its budget instead of evicting clips it just
fetched; a clip that fails twice is skipped until the service restarts. Expect roughly 2 MB and 10–20 s of HomeBase
time per clip. Recordings stay on the HomeBase, so prefetching does not wake the cameras.

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
| `EUFY_CLIPS_CACHE_MB` | `1024` | clip cache budget (least recently used clips are removed) |
| `EUFY_CLIPS_MIN_FREE_MB` | `1024` | the cache budget shrinks so the disk keeps at least this much free |
| `EUFY_CLIPS_PREFETCH_DAYS` | `7` | prefetch clips and thumbnails of the last N days after each sync; `0` = on demand only |
| `EUFY_CLIPS_WIRED_DIR` | `<data>/segments` | RTSP archive of the wired cameras; put it on a disk with room |
| `EUFY_CLIPS_WIRED_DAYS` | `7` | how long that archive is kept; `0` disables recording wired cameras |
| `EUFY_CLIPS_WIRED_MAX_GB` | `200` | size ceiling for the archive; the oldest segments go first |
| `EUFY_CLIPS_NAMES` | – | rename cameras: `SERIAL=Name,SERIAL=Name`. Two cameras given the same name are shown as one, with their events in a single timeline — useful for two angles on the same room |

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
