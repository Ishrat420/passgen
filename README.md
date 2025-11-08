# passgen
Passgen is a minimalist, offline-friendly password generator that lets you create strong, consistent passwords using your own secret formula.
Choose your hashing algorithm (SHA, MD5, Base64), bring your own salt, adjust the output length, and add a custom suffix all without storing a single thing.

## 🔒 Site normalization

When you type a website, Passgen normalizes the value before generating a password so the same site always maps to the same key:

- Leading and trailing whitespace is stripped and the host name is forced to lowercase.
- A leading `www.` is removed to avoid treating the marketing hostname as a separate site.
- If the hostname is just a bare `.com` domain (for example, `facebook.com`), the `.com` suffix is stripped so that `facebook`, `facebook.com`, and `https://www.facebook.com` all collapse to `facebook`.
- Inputs that cannot be parsed as URLs still go through the same cleanup, guaranteeing deterministic output instead of failing.

This behavior lives in [`PasswordGenerator.normalizeSite`](js/generator.js), and ensures common variations of the same address regenerate the identical password without any extra effort from you.

## 📄 License
This project is licensed under the [CC BY-NC 4.0 License](https://creativecommons.org/licenses/by-nc/4.0/).
You may use, adapt, and share it non-commercially with attribution.
