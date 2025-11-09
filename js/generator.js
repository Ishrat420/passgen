import { CryptoHelper } from './crypto.js';

const DEFAULT_LENGTH = 16;
const MIN_LENGTH = 8;
const MAX_LENGTH = 50;

const DEFAULT_PARAMETERS = Object.freeze({
  iterations: 100000,
  argonMem: 64,
  scryptN: 16384,
  balloonSpace: 64,
  balloonTime: 3,
  balloonDelta: 3
});

const CHARSETS = {
  lowers: 'abcdefghijklmnopqrstuvwxyz',
  uppers: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>?'
};

export class PasswordGenerator {
  constructor({
    algorithm = 'PBKDF2-SHA256',
    length = 16,
    policyOn = true,
    compatMode = false,
    parameters = {}
  } = {}) {
    this.algorithm = algorithm;
    // Defensive guard: clamp to supported bounds and fall back to a safe default
    // when callers provide invalid lengths.
    const numericLength = Number(length);
    if (Number.isInteger(numericLength)) {
      this.length = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, numericLength));
    } else {
      // Fall back to a safe default when callers provide invalid lengths.
      this.length = DEFAULT_LENGTH;
    }
    this.policyOn = policyOn;
    this.compatMode = compatMode;
    this.parameters = PasswordGenerator.normalizeParameters(parameters);
  }

  static normalizeSite(site) {
    const canonicalize = value => {
      if (value == null) return '';
      let normalized = String(value).toLowerCase().trim().replace(/^www\./, '');

      // Align bare inputs like "facebook" with their common ".com" hostname so
      // both generate the same password. Only strip ".com" when it is the sole
      // suffix (e.g. "example.com"), preserving other subdomains such as
      // "mail.example.com".
      const dotMatches = normalized.match(/\./g) || [];
      if (dotMatches.length === 1 && normalized.endsWith('.com')) {
        normalized = normalized.slice(0, -4);
      }

      return normalized;
    };

    const rawSite = site == null ? '' : String(site);

    try {
      let input = rawSite.trim();
      if (!input.includes('://')) input = 'https://' + input;
      return canonicalize(new URL(input).hostname);
    } catch {
      return canonicalize(rawSite);
    }
  }

  normalizeSite(site) {
    return PasswordGenerator.normalizeSite(site);
  }

  static normalizeCounter(counter) {
    const raw = String(counter ?? '0').trim();
    if (raw === '') return '0';

    if (/^-?\d+$/.test(raw)) {
      if (typeof BigInt === 'function') {
        try {
          return String(BigInt(raw));
        } catch {
          // Fall back to Number parsing below.
        }
      }

      const parsed = parseInt(raw, 10);
      if (Number.isNaN(parsed)) return raw.replace(/^0+(?=\d)/, '');
      return String(parsed);
    }

    return raw;
  }

  async generate({ site, secret, counter = '0' }) {
    if (/[|]/.test(site) || /[|]/.test(secret)) {
      throw new Error('Inputs may not contain "|" character');
    }

    const normalizedSite = PasswordGenerator.normalizeSite(site);
    const normalizedCounter = PasswordGenerator.normalizeCounter(counter);
    const combined = `${normalizedSite}|${secret}|${normalizedCounter}`;

    let hex;
    switch (this.algorithm) {
      case 'PBKDF2-SHA256': {
        const iterations = parseInt(this.parameters.iterations, 10) || 100000;
        hex = await CryptoHelper.pbkdf2(secret, combined, iterations);
        break;
      }
      case 'Argon2id': {
        const memMB = parseInt(this.parameters.argonMem, 10) || 64;
        hex = await CryptoHelper.argon2(secret, combined, memMB);
        break;
      }
      case 'scrypt': {
        const N = parseInt(this.parameters.scryptN, 10) || 16384;
        hex = await CryptoHelper.scrypt(secret, combined, N);
        break;
      }
      case 'BLAKE2b-512': {
        hex = await CryptoHelper.blake2b(combined, 64);
        break;
      }
      case 'BLAKE2s-256': {
        hex = await CryptoHelper.blake2s(combined, 32);
        break;
      }
      case 'HMAC-SHA256': {
        hex = await CryptoHelper.hmac(secret, combined, 'SHA-256');
        break;
      }
      case 'Balloon-SHA256': {
        const { balloonSpace, balloonTime, balloonDelta } = this.parameters;
        hex = await CryptoHelper.balloon(secret, combined, {
          spaceCost: balloonSpace,
          timeCost: balloonTime,
          delta: balloonDelta,
          hash: 'SHA-256'
        });
        break;
      }
      default:
        hex = await CryptoHelper.digest(combined, this.algorithm);
    }

    const password = this.mapToPassword(hex);
    return { password, normalizedSite, hex, counter: normalizedCounter };
  }

  mapToPassword(hex) {
    const bytes = this.hexToBytes(hex);
    if (!bytes.length) return '';

    const charset = this.compatMode
      ? CHARSETS.lowers + CHARSETS.uppers + CHARSETS.digits + '!@#$%^&*()-_=+'
      : CHARSETS.lowers + CHARSETS.uppers + CHARSETS.digits + CHARSETS.symbols;

    let pwd = '';
    for (let i = 0; i < this.length; i++) {
      pwd += charset[bytes[i % bytes.length] % charset.length];
    }

    if (!this.policyOn) return pwd;

    const arr = pwd.split('');
    const categories = [CHARSETS.uppers, CHARSETS.lowers, CHARSETS.digits, CHARSETS.symbols];
    categories.forEach((set, idx) => {
      const pos = bytes[(idx + 4) % bytes.length] % arr.length;
      arr[pos] = set[bytes[idx % bytes.length] % set.length];
    });

    return arr.join('');
  }

  isDiverse(pwd) {
    return (
      /[A-Z]/.test(pwd) &&
      /[a-z]/.test(pwd) &&
      /\d/.test(pwd) &&
      /[^A-Za-z0-9]/.test(pwd)
    );
  }

  hexToBytes(hex) {
    const output = [];
    for (let i = 0; i < hex.length; i += 2) {
      output.push(parseInt(hex.slice(i, i + 2), 16));
    }
    return output;
  }

  static sanitizeParameter(value, defaultValue, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    const clamped = Math.min(Math.max(parsed, min), max);
    if (!Number.isFinite(clamped) || clamped <= 0) return defaultValue;
    return clamped;
  }

  static normalizeParameters(parameters = {}) {
    const normalized = {
      iterations: this.sanitizeParameter(parameters.iterations, DEFAULT_PARAMETERS.iterations, { min: 1000, max: 10000000 }),
      argonMem: this.sanitizeParameter(parameters.argonMem, DEFAULT_PARAMETERS.argonMem, { min: 8, max: 4096 }),
      scryptN: this.sanitizeParameter(parameters.scryptN, DEFAULT_PARAMETERS.scryptN, { min: 1024, max: 1048576 }),
      balloonSpace: this.sanitizeParameter(parameters.balloonSpace, DEFAULT_PARAMETERS.balloonSpace, {
        min: 4,
        max: 4096
      }),
      balloonTime: this.sanitizeParameter(parameters.balloonTime, DEFAULT_PARAMETERS.balloonTime, {
        min: 1,
        max: 24
      }),
      balloonDelta: this.sanitizeParameter(parameters.balloonDelta, DEFAULT_PARAMETERS.balloonDelta, {
        min: 1,
        max: 8
      })
    };
    return normalized;
  }

  static buildRecipeSignature({ algorithm, site, counter, length, policyOn, compatMode, parameters = {} }) {
    const normalizedCounter = this.normalizeCounter(counter);
    const normalizedParameters = this.normalizeParameters(parameters);
    const parameterSignature = [
      `iterations=${normalizedParameters.iterations}`,
      `argonMem=${normalizedParameters.argonMem}`,
      `scryptN=${normalizedParameters.scryptN}`,
      `balloonSpace=${normalizedParameters.balloonSpace}`,
      `balloonTime=${normalizedParameters.balloonTime}`,
      `balloonDelta=${normalizedParameters.balloonDelta}`
    ].join(';');
    return `${algorithm}|${site}|${normalizedCounter}|${length}|${policyOn}|${compatMode}|${parameterSignature}`;
  }

  static async computeRecipeId(details) {
    const signature = typeof details === 'string' ? details : this.buildRecipeSignature(details);
    const digest = await CryptoHelper.digest(signature, 'SHA-256');
    return { signature, digest, short: digest.slice(0, 8) };
  }
}
