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

  static bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  }
}
