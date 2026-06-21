# macOS code signing & notarization

The release workflow signs and notarizes the macOS build so users don't get the
**"Dockit is damaged and can't be opened"** Gatekeeper error. That message appears
when an unsigned, un-notarized app is downloaded (the OS adds a `com.apple.quarantine`
flag and refuses to launch it).

Signing only runs when the repository secrets below are present. Without them the
build still succeeds — it just produces an unsigned app.

## Prerequisites

- A paid **Apple Developer account** ($99/yr).
- A **Developer ID Application** certificate (Keychain Access → Certificate Assistant,
  or download from the Apple Developer portal). This is the cert type required for apps
  distributed *outside* the App Store.

## Required GitHub secrets

Add these under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | The `.p12` export of your Developer ID Application cert + private key, **base64-encoded**: `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | The full identity string, e.g. `Developer ID Application: Your Name (TEAMID)` — find it with `security find-identity -v -p codesigning` |
| `KEYCHAIN_PASSWORD` | Any random string; used for the temporary keychain the CI creates |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_PASSWORD` | An **app-specific password** (not your Apple ID password) generated at <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | Your 10-character Team ID (Apple Developer portal → Membership) |

## Exporting the certificate

1. Open **Keychain Access**, find your *Developer ID Application* cert.
2. Expand it, select **both** the certificate and its private key.
3. Right-click → **Export 2 items…** → save as `cert.p12`, set a password.
4. Base64-encode it for the secret:

   ```bash
   base64 -i cert.p12 | pbcopy
   ```

## How it works

`tauri-action` reads these env vars during the release build:

- `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` /
  `KEYCHAIN_PASSWORD` → import the cert and **code sign** the app with the hardened runtime.
- `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` → submit the app to Apple for
  **notarization**, then **staple** the ticket to the `.app` and `.dmg`.

After this the downloaded DMG opens with no warnings on any Mac.

## Notes

- The runner is `macos-latest` (Apple Silicon / arm64), so the DMG is **arm64-only**.
  Intel Macs can't run it. To ship a universal binary, build with
  `--target universal-apple-darwin` (and add both rust targets in CI).
- The local `bun run build:dmg` script uses `--no-sign` on purpose — locally built apps
  aren't quarantined, so they run without signing.
