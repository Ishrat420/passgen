import { CryptoHelper } from './crypto.js';

const DEFAULT_LENGTH = 16;
const MIN_LENGTH = 8;
const MAX_LENGTH = 50;

const DEFAULT_PIN_LENGTH = 4;
const MIN_PIN_LENGTH = 3;
const MAX_PIN_LENGTH = 12;

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
    outputType = 'password',
    length = outputType === 'pin' ? DEFAULT_PIN_LENGTH : DEFAULT_LENGTH,
    policyOn = true,
    compatMode = false,
    parameters = {}
  } = {}) {
    this.algorithm = algorithm;
    this.outputType = outputType === 'pin' ? 'pin' : 'password';

    const minLength = this.outputType === 'pin' ? MIN_PIN_LENGTH : MIN_LENGTH;
    const maxLength = this.outputType === 'pin' ? MAX_PIN_LENGTH : MAX_LENGTH;
    const defaultLength = this.outputType === 'pin' ? DEFAULT_PIN_LENGTH : DEFAULT_LENGTH;

    // Defensive guard: clamp to supported bounds and fall back to a safe default
    // when callers provide invalid lengths.
    const numericLength = Number(length);
    if (Number.isInteger(numericLength)) {
      this.length = Math.min(maxLength, Math.max(minLength, numericLength));
    } else {
      // Fall back to a safe default when callers provide invalid lengths.
      this.length = defaultLength;
    }
    this.policyOn = policyOn;
    this.compatMode = compatMode;
    this.parameters = PasswordGenerator.normalizeParameters(parameters);
  }

  static normalizeSite(site) {
    const rawSite = site == null ? '' : String(site);
    const trimmed = rawSite.trim();
    if (!trimmed) return '';

    const isUrlLike =
      /:\/\//.test(trimmed) ||
      /^www\./i.test(trimmed) ||
      trimmed.includes('.');
    if (!isUrlLike) return trimmed;

    let hostname = trimmed.toLowerCase();
    try {
      let input = hostname;
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
        input = `https://${input}`;
      }
      hostname = new URL(input).hostname;
    } catch {
      // Fall back to raw input when URL parsing fails.
    }

    return hostname.toLowerCase().trim().replace(/^www\./, '').replace(/\.+$/, '');
  }

  normalizeSite(site) {
    return PasswordGenerator.normalizeSite(site);
  }

  static normalizeAccount(account) {
    if (account == null) return '';
    return String(account).trim().toLowerCase();
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

  async generate({ site, account = '', secret, counter = '0', normalizeSite = true }) {
    if (/[|]/.test(site) || /[|]/.test(secret) || /[|]/.test(account)) {
      throw new Error('Inputs may not contain "|" character');
    }

    const normalizedSite = normalizeSite
      ? PasswordGenerator.normalizeSite(site)
      : String(site ?? '').trim();
    const normalizedAccount = PasswordGenerator.normalizeAccount(account);
    const normalizedCounter = PasswordGenerator.normalizeCounter(counter);
    const combined = normalizedAccount
      ? `${normalizedSite}|${normalizedAccount}|${secret}|${normalizedCounter}`
      : `${normalizedSite}|${secret}|${normalizedCounter}`;

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

    const password = this.outputType === 'pin' ? this.mapToPin(hex) : this.mapToPassword(hex);
    return { password, normalizedSite, normalizedAccount, hex, counter: normalizedCounter };
  }

  mapToPin(hex) {
    const bytes = this.hexToBytes(hex);
    if (!bytes.length) return '';

    const digits = CHARSETS.digits;
    let pin = '';
    for (let i = 0; i < this.length; i++) {
      pin += digits[bytes[i % bytes.length] % 10];
    }

    return pin;
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

  static buildRecipeSignature({
    algorithm,
    site,
    account = '',
    counter,
    outputType = 'password',
    length,
    policyOn,
    compatMode,
    parameters = {}
  }) {
    const normalizedAccount = this.normalizeAccount(account);
    const normalizedCounter = this.normalizeCounter(counter);
    const normalizedOutputType = outputType === 'pin' ? 'pin' : 'password';
    const normalizedParameters = this.normalizeParameters(parameters);
    const parameterSignature = [
      `iterations=${normalizedParameters.iterations}`,
      `argonMem=${normalizedParameters.argonMem}`,
      `scryptN=${normalizedParameters.scryptN}`,
      `balloonSpace=${normalizedParameters.balloonSpace}`,
      `balloonTime=${normalizedParameters.balloonTime}`,
      `balloonDelta=${normalizedParameters.balloonDelta}`
    ].join(';');
    const signatureParts = [algorithm, site];
    if (normalizedAccount) {
      signatureParts.push(normalizedAccount);
    }
    signatureParts.push(
      normalizedCounter,
      normalizedOutputType,
      length,
      policyOn,
      compatMode,
      parameterSignature
    );
    return signatureParts.join('|');
  }

  static async computeRecipeId(details) {
    const signature = typeof details === 'string' ? details : this.buildRecipeSignature(details);
    const digest = await CryptoHelper.digest(signature, 'SHA-256');
    return { signature, digest, short: digest.slice(0, 8) };
  }
}
