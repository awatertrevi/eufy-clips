// Logging with repeat suppression.
//
// A service that loses its network keeps failing at the same spot: during an outage on 25-11-2026 the
// P2P layer wrote 222,757 identical "send ENETUNREACH" lines in seven hours. That filled the journal's
// 200 MB and pushed out the kernel messages from the moment the wifi died, so the one thing worth
// keeping was the one thing lost. Repeats are therefore counted instead of written, and the count is
// reported once the window passes, which keeps the first occurrence (the useful one) and the rate.

const WINDOW_MS = 60_000;
// Enough for every distinct failure a run produces; beyond that the oldest are forgotten.
const MAX_KEYS = 500;

/** Collapse the parts that vary per occurrence (addresses, ids, offsets) so repeats share a key. */
const keyOf = (level, line) => `${level}\u0000${line.replace(/\d+/g, "#").slice(0, 200)}`;

const text = value => (typeof value === "string" ? value : String(value));

export function createLog({ out = console, now = () => Date.now(), windowMs = WINDOW_MS } = {}) {
  const seen = new Map();

  const forget = at => {
    for (const [key, entry] of seen) if (at - entry.since >= windowMs) seen.delete(key);
    if (seen.size > MAX_KEYS) seen.clear();
  };

  const write = (level, method, prefix, parts) => {
    const at = now();
    const line = parts.map(text).join(" ");
    const key = keyOf(level, line);
    const entry = seen.get(key);
    if (!entry) {
      if (seen.size >= MAX_KEYS) forget(at);
      seen.set(key, { count: 0, since: at });
      out[method](new Date(at).toISOString(), ...prefix, ...parts);
      return;
    }
    entry.count++;
    if (at - entry.since < windowMs) return;
    const seconds = Math.round((at - entry.since) / 1000);
    out[method](new Date(at).toISOString(), ...prefix, ...parts, `(${entry.count}x in ${seconds}s)`);
    seen.set(key, { count: 0, since: at });
  };

  return {
    info: (...a) => write("info", "log", [], a),
    warn: (...a) => write("warn", "warn", ["WARN"], a),
    error: (...a) => write("error", "error", ["ERROR"], a),
  };
}
