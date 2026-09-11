# Clop VPN Mobile

Native Android 8+ client for the Clop VPN service.

Features:

- Telegram account pairing through the existing Clop device flow;
- WireGuard keys generated and retained on the phone;
- native userspace WireGuard tunnel;
- animated connection control and location picker;
- live transfer speed, weekly traffic and plan limit;
- one active location (Germany, Falkenstein) with upcoming locations shown separately.

Build with `gradlew.bat assembleRelease`. A local `signing.properties` can provide `storeFile`, `storePassword`, `keyAlias` and `keyPassword`; it is intentionally excluded from Git.

The tunnel implementation uses the official Apache-2.0 licensed `com.wireguard.android:tunnel` library.
