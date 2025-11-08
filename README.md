# passgen
Passgen is a minimalist, offline-friendly password generator that lets you create strong, consistent passwords using your own secret formula.
Choose your hashing algorithm (pbkdf2-sha256, Argon2id, SHA) bring your own salt, adjust the output length, and increment password counter all without storing a single thing on cloud. 

## 🔒 Site normalization
When you type a website, Passgen normalizes the value before generating a password so the same site always maps to the same key:
- If the hostname is just a bare `.com` domain (for example, `facebook.com`), the `.com` suffix is stripped so that `facebook`, `facebook.com`, and `https://www.facebook.com` all collapse to `facebook`.

## 📄 License
This project is licensed under the [CC BY-NC 4.0 License](https://creativecommons.org/licenses/by-nc/4.0/).
You may use, adapt, and share it non-commercially with attribution.
