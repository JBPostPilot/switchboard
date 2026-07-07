# Releasing Switchboard

Maintainer notes for cutting a signed, notarized release. Users don't need any of this —
see the README to just run the app.

## Signing & notarizing

`npm run dist` produces a working unsigned DMG (users must right-click → Open the first
time). For a properly signed + notarized build, you need an Apple Developer account with a
**Developer ID Application** certificate in your keychain, then:

```sh
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com → app-specific passwords
export APPLE_TEAM_ID="XXXXXXXXXX"
npm run dist
```

electron-builder finds the certificate automatically, signs everything (including the
bundled Claude Code engine binary) with the hardened runtime + `build/entitlements.mac.plist`,
notarizes with Apple, and staples the ticket. No credentials → it skips signing with a
warning and still produces the DMG.

Verify a signed build before publishing:

```sh
spctl --assess --type open --context context:primary-signature -v dist/Switchboard-*.dmg
xcrun stapler validate dist/Switchboard-*.dmg
```

## Publishing

```sh
gh release create v<version> dist/Switchboard-<version>-arm64.dmg
```
