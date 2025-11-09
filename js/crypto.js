/* ==========================================================================
   MODULE: CryptoHelper — Static cryptography utilities
   ========================================================================= */

export class CryptoHelper {
  static async pbkdf2(pass, salt, iterations = 100000, length = 32) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(pass), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: encoder.encode(salt), iterations, hash: 'SHA-256' },
      key,
      length * 8
    );
    return this.bufferToHex(bits);
  }

  static async argon2(pass, salt, memMB = 64) {
    const options = {
      pass,
      salt,
      time: 3,
      mem: memMB * 1024,
      parallelism: 1,
      hashLen: 32,
      type: argon2.ArgonType.Argon2id
    };
    const { hashHex } = await argon2.hash(options);
    return hashHex;
  }

  static async scrypt(pass, salt, N = 16384) {
    const encoder = new TextEncoder();
    const derived = await scrypt.scrypt(encoder.encode(pass), encoder.encode(salt), N, 8, 1, 32);
    return this.bufferToHex(derived);
  }

  static async digest(input, algorithm = 'SHA-256') {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hash = await crypto.subtle.digest(algorithm, data);
    return this.bufferToHex(hash);
  }

  static resolveBlake() {
    const blake = typeof globalThis !== 'undefined' ? globalThis.blakejs : undefined;
    if (!blake) {
      throw new Error('BLAKE2 support is not available.');
    }
    return blake;
  }

  static async blake2b(input, outBytes = 64) {
    const blake = this.resolveBlake();
    if (typeof blake.blake2bHex !== 'function') {
      throw new Error('BLAKE2b support is not available.');
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    return blake.blake2bHex(data, null, outBytes);
  }

  static async blake2s(input, outBytes = 32) {
    const blake = this.resolveBlake();
    if (typeof blake.blake2sHex !== 'function') {
      throw new Error('BLAKE2s support is not available.');
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    return blake.blake2sHex(data, null, outBytes);
  }

  static async hmac(key, message, hash = 'SHA-256') {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const messageData = encoder.encode(message);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: { name: hash } },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    return this.bufferToHex(signature);
  }

  static async balloon(pass, salt, { spaceCost = 64, timeCost = 3, delta = 3, hash = 'SHA-256' } = {}) {
    const encoder = new TextEncoder();
    const passwordBytes = encoder.encode(pass);
    const saltBytes = encoder.encode(salt);

    const normalizedSpace = Number.isFinite(spaceCost) && spaceCost > 0 ? Math.min(Math.max(spaceCost, 4), 4096) : 64;
    const normalizedTime = Number.isFinite(timeCost) && timeCost > 0 ? Math.min(Math.max(timeCost, 1), 24) : 3;
    const normalizedDelta = Number.isFinite(delta) && delta > 0 ? Math.min(Math.max(delta, 1), 8) : 3;

    const buffer = new Array(normalizedSpace);

    const toBytes = value => {
      const bytes = new Uint8Array(8);
      let num = BigInt(Math.max(0, Number(value) || 0));
      for (let i = 7; i >= 0; i--) {
        bytes[i] = Number(num & 0xffn);
        num >>= 8n;
      }
      return bytes;
    };

    const hashBytes = async (...parts) => {
      const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      parts.forEach(part => {
        combined.set(part, offset);
        offset += part.length;
      });
      const digest = await crypto.subtle.digest(hash, combined);
      return new Uint8Array(digest);
    };

    const integerify = bytes => {
      if (!bytes.length) return 0;
      let value = 0;
      const length = Math.min(4, bytes.length);
      for (let i = 0; i < length; i++) {
        value = (value << 8) | bytes[i];
      }
      return value >>> 0;
    };

    buffer[0] = await hashBytes(toBytes(0), passwordBytes, saltBytes);
    for (let m = 1; m < normalizedSpace; m++) {
      buffer[m] = await hashBytes(toBytes(m), buffer[m - 1]);
    }

    for (let t = 0; t < normalizedTime; t++) {
      for (let m = 0; m < normalizedSpace; m++) {
        const counter = toBytes(t * normalizedSpace + m);
        const prev = buffer[(m - 1 + normalizedSpace) % normalizedSpace];
        buffer[m] = await hashBytes(counter, prev, buffer[m]);
      }

      for (let m = 0; m < normalizedSpace; m++) {
        for (let j = 0; j < normalizedDelta; j++) {
          const mixSeed = await hashBytes(toBytes(t), toBytes(m), toBytes(j), buffer[m]);
          const otherIndex = integerify(mixSeed) % normalizedSpace;
          const prev = buffer[(m - 1 + normalizedSpace) % normalizedSpace];
          buffer[m] = await hashBytes(toBytes(t), toBytes(m), toBytes(j), prev, buffer[otherIndex]);
        }
      }
    }

    return this.bufferToHex(buffer[normalizedSpace - 1]);
  }

  static bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  }
}
