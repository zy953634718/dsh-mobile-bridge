// PIN pairing gate: random 6-digit PIN, constant-time comparison, and a
// per-IP failed-attempt window. Node builtins only.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

const PIN_LENGTH = 6;
const DIGITS = '0123456789';

/**
 * Generate a cryptographically random 6-digit PIN. Leading zeros are kept, so
 * the value is a 6-character digit string.
 * @param {(min: number, max: number) => number} [nextInt] injectable RNG.
 * @returns {string} 6 ASCII digits.
 */
export function generatePin(nextInt = randomInt) {
  let pin = '';
  for (let index = 0; index < PIN_LENGTH; index += 1) {
    pin += DIGITS[nextInt(0, DIGITS.length)];
  }
  return pin;
}

/**
 * Constant-time comparison of two secrets regardless of their length: both
 * sides are hashed first, so the comparison cost does not depend on where the
 * inputs differ or how long they are.
 * @param {unknown} left candidate secret.
 * @param {unknown} right expected secret.
 * @returns {boolean} true when the textual values are identical.
 */
export function secretsMatch(left, right) {
  const leftHash = createHash('sha256').update(String(left ?? ''), 'utf8').digest();
  const rightHash = createHash('sha256').update(String(right ?? ''), 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

/** Normalize a configured PIN: trimmed text, or '' when unusable. */
function normalizeConfiguredPin(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = String(Math.trunc(value));
    return /^\d+$/u.test(text) ? text : '';
  }
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text === '' ? '' : text;
}

/** Normalize a submitted PIN: trim text, accept a JSON number as digits. */
function normalizeSubmittedPin(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * Per-process PIN + per-IP attempt limiter.
 *
 * Semantics (`pairAttempts` N): the first N failed attempts from one IP return
 * `bad-pin`; the (N+1)th and every later attempt inside the window return
 * `locked` until the window expires. A successful pairing clears that IP.
 */
export class PairingGate {
  /**
   * @param {object} [options]
   * @param {unknown} [options.pin] fixed PIN override (tests/dev), else random.
   * @param {number} [options.pairAttempts] failures per IP per window.
   * @param {number} [options.windowMs] limiter window length in ms.
   * @param {() => number} [options.now] injectable clock (tests).
   */
  constructor(options = {}) {
    const configured = normalizeConfiguredPin(options.pin);
    /** @type {string} */
    this.pin = configured !== '' ? configured : generatePin();
    this.pinWasConfigured = configured !== '';
    this.pairAttempts = positiveInteger(options.pairAttempts, 8);
    this.windowMs = positiveInteger(options.windowMs, 10 * 60 * 1000);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    /** @type {Map<string, {count: number, windowStart: number}>} */
    this.records = new Map();
  }

  /**
   * Check one submitted PIN for one peer IP.
   * @param {unknown} code submitted PIN value.
   * @param {string} ip normalized peer address (limiter key).
   * @returns {{ok: true} | {ok: false, error: 'bad-pin'|'locked', attemptsLeft?: number, retryAfterMs?: number}}
   */
  verify(code, ip) {
    const key = typeof ip === 'string' && ip !== '' ? ip : 'unknown';
    const now = this.now();
    let record = this.records.get(key);
    if (record !== undefined && now - record.windowStart >= this.windowMs) {
      this.records.delete(key);
      record = undefined;
    }
    if (record !== undefined && record.count >= this.pairAttempts) {
      return {
        ok: false,
        error: 'locked',
        retryAfterMs: Math.max(0, record.windowStart + this.windowMs - now),
      };
    }
    const submitted = normalizeSubmittedPin(code);
    if (secretsMatch(submitted, this.pin)) {
      this.records.delete(key);
      return { ok: true };
    }
    if (record === undefined) {
      record = { count: 0, windowStart: now };
      this.records.set(key, record);
    }
    record.count += 1;
    this.prune();
    return {
      ok: false,
      error: 'bad-pin',
      attemptsLeft: Math.max(0, this.pairAttempts - record.count),
    };
  }

  /** Drop expired limiter records and cap the table so a hostile LAN cannot grow it without bound. */
  prune() {
    if (this.records.size <= 256) return;
    const now = this.now();
    for (const [key, record] of this.records) {
      if (now - record.windowStart >= this.windowMs) this.records.delete(key);
    }
    while (this.records.size > 1024) {
      const oldest = this.records.keys().next();
      if (oldest.done === true) break;
      this.records.delete(oldest.value);
    }
  }
}

/** Positive integer option with a default. */
function positiveInteger(value, fallback) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

export { PIN_LENGTH };
