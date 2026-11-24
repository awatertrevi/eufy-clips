// One long-lived Eufy session: login (with 2FA via the web UI), HomeBase database queries,
// thumbnail and clip downloads. Everything goes over the P2P session eufy-security-client keeps open.
import { EventEmitter } from "node:events";
import { EufySecurity, LogLevel } from "eufy-security-client";
import { ClipDecoder, cipherKeyId } from "./decode.mjs";

const CMD_SET_PAYLOAD = 1350;
const CMD_DATABASE = 1306;
const CMD_DATABASE_QUERY_LOCAL = 10017;
const BINARY = 3;

export class EufyClient extends EventEmitter {
  state = "starting";
  #eufy;
  #config;
  #log;
  #pendingQueries = new Map();
  #pendingImages = new Map();
  #ciphers = new Map();
  #download = null;
  #tasks = [];
  #busy = false;

  constructor(config, log) {
    super();
    this.#config = config;
    this.#log = log;
  }

  async start() {
    const capture = level => (message, ...args) => {
      const text = String(message);
      if (text.includes("CMD_DATABASE :")) return this.#onDatabaseReply(args[0]?.payload);
      if (level === "warn" || level === "error") this.#log[level](`eufy: ${text}`, args.length ? JSON.stringify(args).slice(0, 300) : "");
    };
    this.#eufy = await EufySecurity.initialize({
      username: this.#config.username,
      password: this.#config.password,
      country: this.#config.country,
      language: "en",
      trustedDeviceName: "eufy-clips",
      persistentDir: this.#config.dataDir,
      p2pConnectionSetup: 0,
      pollingIntervalMinutes: 30,
      eventDurationSeconds: 10,
      acceptInvitations: true,
      logging: { level: LogLevel.Info, categories: [{ category: "p2p", level: LogLevel.Debug }] },
    }, { trace() {}, debug: capture("debug"), info() {}, warn: capture("warn"), error: capture("error") });

    this.#eufy.on("tfa request", () => this.#setState("needs-2fa"));
    this.#eufy.on("captcha request", (id, captcha) => {
      this.captcha = { id, image: captcha };
      this.#setState("needs-captcha");
    });
    this.#eufy.on("connection error", error => this.#log.warn(`eufy: connection error ${error}`));
    this.#eufy.on("connect", () => this.#setState("connected"));
    this.#eufy.on("close", () => this.#setState("disconnected"));
    this.#eufy.on("station image download", (station, file, image) => {
      const pending = this.#pendingImages.get(file);
      if (pending) pending.resolve(image?.data);
    });
    this.#eufy.on("station download finish", station => {
      if (this.#download?.station === station.getSerial()) this.#download.finish();
    });
    await this.#eufy.connect();
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.#log.info(`eufy: ${state}`);
    this.emit("state", state);
  }

  async submitCode(code) {
    await this.#eufy.connect({ verifyCode: code, force: false });
  }

  async submitCaptcha(answer) {
    await this.#eufy.connect({ captcha: { captchaId: this.captcha?.id, captchaCode: answer }, force: false });
  }

  /** HomeBase 2 stations (T8010) on the account, optionally limited to the configured serials. */
  async stations() {
    const all = await this.#eufy.getStations();
    return all.filter(s => s.getModel() === "T8010" &&
      (!this.#config.stations.length || this.#config.stations.includes(s.getSerial())));
  }

  async cameras() {
    const stations = new Set((await this.stations()).map(s => s.getSerial()));
    return (await this.#eufy.getDevices())
      .filter(d => stations.has(d.getStationSerial()) && d.isCamera())
      .map(d => ({ serial: d.getSerial(), name: d.getName(), model: d.getModel(), station: d.getStationSerial() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async #station(serial) {
    const station = await this.#eufy.getStation(serial);
    if (!station.isConnected()) {
      station.connect();
      for (let i = 0; i < 30 && !station.isConnected(); i++) await sleep(1000);
      if (!station.isConnected()) throw new Error(`station ${serial} not reachable over P2P`);
    }
    return station;
  }

  /**
   * Run P2P work one task at a time (the HomeBase handles one request per session reliably), highest
   * priority first: a clip someone is waiting for must not queue behind thumbnails or a backfill sync, and
   * background prefetching always comes last.
   */
  #serial(task, priority = PRIORITY.sync) {
    return new Promise((resolve, reject) => {
      this.#tasks.push({ task, priority, resolve, reject });
      this.#next();
    });
  }

  /** True when no P2P work is running or waiting; background prefetching only starts then. */
  get idle() {
    return !this.#busy && !this.#tasks.length;
  }

  async #next() {
    if (this.#busy || !this.#tasks.length) return;
    this.#busy = true;
    const index = this.#tasks.reduce((best, t, i, all) => (t.priority > all[best].priority ? i : best), 0);
    const [{ task, resolve, reject }] = this.#tasks.splice(index, 1);
    try { resolve(await task()); } catch (error) { reject(error); }
    this.#busy = false;
    this.#next();
  }

  /**
   * Query the HomeBase event table (command 10017). The station needs start_date < end_date and
   * treats start_time as a cursor: "0" means newest first, a YYYYMMDDHHmmss value returns older rows.
   */
  queryEvents(stationSerial, devices, { startDate, endDate, cursor = "0", count = 100 }) {
    return this.#serial(async () => {
      const station = await this.#station(stationSerial);
      const transaction = `${Date.now()}`;
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pendingQueries.delete(transaction);
          reject(new Error("database query timed out"));
        }, 10_000);
        this.#pendingQueries.set(transaction, value => { clearTimeout(timer); resolve(value); });
      });
      station.p2pSession.sendCommandWithStringPayload({
        commandType: CMD_SET_PAYLOAD,
        channel: 0,
        value: JSON.stringify({
          account_id: station.rawStation.member.admin_user_id, cmd: CMD_DATABASE, mChannel: 0, mValue3: 0,
          payload: {
            cmd: CMD_DATABASE_QUERY_LOCAL, table: "history_record_info", transaction,
            payload: {
              count, detection_type: 0, device_info: devices.map(device_sn => ({ device_sn })),
              start_date: startDate, end_date: endDate, start_time: cursor,
              event_type: 0, flag: 0, res_unzip: 1, storage_cloud: -1, ai_type: 0,
            },
          },
        }),
      });
      const response = await reply;
      if (response.mIntRet !== 0) throw new Error(`database query failed: ${response.mIntRet} ${response.msg}`);
      const tables = Array.isArray(response.data) ? response.data : [];
      const history = tables.find(t => t.table_name === "history_record_info")?.payload ?? [];
      const pictures = tables.find(t => t.table_name === "record_crop_picture_info")?.payload ?? [];
      return { history, pictures };
    });
  }

  #onDatabaseReply(payload) {
    if (typeof payload !== "string") return;
    let response;
    try { response = JSON.parse(payload); } catch { return; }
    const pending = this.#pendingQueries.get(String(response.transaction));
    if (!pending) return;
    this.#pendingQueries.delete(String(response.transaction));
    pending(response);
  }

  /** Fetch the decrypted JPEG thumbnail stored next to an event on the HomeBase. */
  thumbnail(stationSerial, file, { background = false } = {}) {
    return this.#serial(async () => {
      const station = await this.#station(stationSerial);
      const image = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.#pendingImages.delete(file); reject(new Error("thumbnail timed out")); }, 15_000);
        this.#pendingImages.set(file, { resolve: data => { clearTimeout(timer); this.#pendingImages.delete(file); resolve(data); } });
      });
      station.downloadImage(file);
      return image;
    }, background ? PRIORITY.prefetch : PRIORITY.thumbnail);
  }

  async #eccKey(station, cipherId) {
    const id = cipherKeyId(cipherId);
    if (!this.#ciphers.has(id)) {
      const ciphers = await station.api.getCiphers([id], station.rawStation.member.admin_user_id);
      const key = ciphers?.[id]?.ecc_private_key;
      if (!key) throw new Error(`no ecc key for cipher ${id}`);
      this.#ciphers.set(id, key);
    }
    return this.#ciphers.get(id);
  }

  /** Download one recorded clip and return its decrypted H.264 and AAC elementary streams. */
  downloadClip(event, { background = false } = {}) {
    return this.#serial(async () => {
      const station = await this.#station(event.station);
      const device = await this.#eufy.getDevice(event.device);
      const decoder = new ClipDecoder(await this.#eccKey(station, event.cipher));
      const session = station.p2pSession;
      // The HomeBase may take >10 s to start sending; the library's default 5 s wait would cancel it.
      session.streamTimeouts.streamDataWait = 30_000;
      if (!session.__eufyClipsOriginal) {
        session.__eufyClipsOriginal = session.handleDataBinaryAndVideo.bind(session);
        session.handleDataBinaryAndVideo = message => {
          const download = this.#download;
          if (message.dataType === BINARY && download?.station === station.getSerial()) {
            // A cancelled earlier download can still be arriving; only frames on this camera's channel count.
            if (message.channel !== download.channel) return undefined;
            download.decoder.push(message.commandId, message.signCode, message.data);
            download.touch();
            // The library cancels the download (CMD_DOWNLOAD_CANCEL) when it sees no data for its stream
            // timeout; frames handled here bypass it, so keep its timer alive ourselves.
            session.waitForStreamData(BINARY, true);
            return undefined;
          }
          return session.__eufyClipsOriginal(message);
        };
      }
      const videoFrames = () => decoder.stats.clear + decoder.stats.encrypted + decoder.stats.failed;
      const done = new Promise((resolve, reject) => {
        // The HomeBase can take well over 10 s before the first frame and pauses mid-transfer. The library
        // only reports CMD_DOWNLOAD_FINISH for streams it handled itself, so completion is "all recorded
        // frames arrived" (then a short wait for trailing audio), with long silence as the fallback.
        let idle = setTimeout(() => finish(new Error("HomeBase sent no clip data")), 30_000);
        const touch = () => {
          clearTimeout(idle);
          idle = setTimeout(() => finish(), event.frames && videoFrames() >= event.frames ? 2_000 : 20_000);
        };
        const hard = setTimeout(() => finish(new Error("clip download timed out")), 120_000);
        const finish = error => {
          clearTimeout(idle); clearTimeout(hard);
          this.#download = null;
          error ? reject(error) : resolve();
        };
        this.#download = { station: station.getSerial(), channel: device.getChannel(), decoder, touch, finish: () => finish() };
      });
      await station.startDownload(device, event.path);
      try {
        await done;
        if (!decoder.ok) throw new Error(`clip did not decrypt: ${JSON.stringify(decoder.stats)}`);
        // A truncated clip is not cached; the next play retries the download.
        if (event.frames && videoFrames() < event.frames * 0.9) throw new Error(`clip incomplete: ${videoFrames()}/${event.frames} frames`);
      } catch (error) {
        try { station.cancelDownload(device); } catch {}
        await sleep(3_000);
        throw error;
      }
      return { video: Buffer.concat(decoder.video), audio: Buffer.concat(decoder.audio), fps: decoder.fps ?? 15, stats: { ...decoder.stats, fps: decoder.fps } };
    }, background ? PRIORITY.prefetch : PRIORITY.clip);
  }

  close() {
    this.#eufy?.close();
  }
}

const PRIORITY = { prefetch: -1, sync: 0, thumbnail: 1, clip: 2 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
