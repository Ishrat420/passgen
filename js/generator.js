import { CryptoHelper } from './crypto.js';

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
    this.length = length;
    this.policyOn = policyOn;
    this.compatMode = compatMode;
    this.parameters = {
      iterations: parameters.iterations ?? 100000,
      argonMem: parameters.argonMem ?? 64,
      scryptN: parameters.scryptN ?? 16384
    };
  }

  static normalizeSite(site) {
    try {
      let input = site.trim();
      if (!input.includes('://')) input = 'https://' + input;
      return new URL(input).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return site.toLowerCase().trim();
    }
  }

  normalizeSite(site) {
    return PasswordGenerator.normalizeSite(site);
  }

  async generate({ site, secret, counter = '0' }) {
    if (/[|]/.test(site) || /[|]/.test(secret)) {
      throw new Error('Inputs may not contain "|" character');
    }

    const normalizedSite = PasswordGenerator.normalizeSite(site);
    const combined = `${normalizedSite}|${secret}|${counter}`;

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
      default:
        hex = await CryptoHelper.digest(combined, this.algorithm);
    }

    const password = this.mapToPassword(hex);
    return { password, normalizedSite, hex };
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

  static buildRecipeSignature({ algorithm, site, counter, length, policyOn, compatMode }) {
    return `${algorithm}|${site}|${counter}|${length}|${policyOn}|${compatMode}`;
  }

  static async computeRecipeId(details) {
    const signature = typeof details === 'string' ? details : this.buildRecipeSignature(details);
    const digest = await CryptoHelper.digest(signature, 'SHA-256');
    return { signature, digest, short: digest.slice(0, 8) };
  }
}
