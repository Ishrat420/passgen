# passgen
Passgen is a minimalist, offline-friendly password generator that lets you create strong, consistent passwords using your own secret formula.
Choose your hashing algorithm (pbkdf2-sha256, Argon2id, SHA), bring your own salt, adjust output length, and increment version counters all without storing a single thing on cloud. Passwords and PINs use separate tracks, so each output type keeps its own version counter, length preference, recipe history, and derivation domain.

## 🔒 Site normalization
When you type a website, Passgen normalizes the value before generating a password so the same site always maps to the same key:
- If the hostname is just a bare `.com` domain (for example, `facebook.com`), the `.com` suffix is stripped so that `facebook`, `facebook.com`, and `https://www.facebook.com` all collapse to `facebook`.

## 🌐 Keeping BLAKE2 support available
Passgen relies on the upstream [`blakejs`](https://github.com/dcposch/blakejs) bundle for BLAKE2b/BLAKE2s hashing. To avoid a single point of failure, the app now tries three separate CDNs (jsDelivr, unpkg, and cdnjs) when loading `blakejs`. If one provider is blocked or offline, the next mirror is attempted synchronously before the UI boots, greatly improving the odds that BLAKE-based recipes will work without needing to vendor the library yourself.

If you need completely offline support, download `blake.min.js` from the upstream repository, add it to `js/vendor/`, and replace the CDN tags in `index.html` with a local reference—no other application code changes are required.

## 📄 License
This project is licensed under the [CC BY-NC 4.0 License](https://creativecommons.org/licenses/by-nc/4.0/).
You may use, adapt, and share it non-commercially with attribution.
