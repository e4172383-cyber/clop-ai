# Clop for iPhone

Это отдельное нативное приложение на SwiftUI. Оно не открывает сайт внутри `WKWebView`: Telegram-вход, профиль, модели, чат и облако работают напрямую через `URLSession` и Clop API.

## Сборка

1. На macOS установите Xcode 16 и XcodeGen.
2. Выполните `xcodegen generate --spec ios/project.yml` из корня репозитория.
3. Откройте `ios/ClopIOS.xcodeproj`, выберите команду разработчика и запустите на iPhone или симуляторе.

GitHub Actions автоматически собирает и тестирует версию для iOS Simulator без подписи. Для установки на настоящий iPhone через TestFlight нужны членство Apple Developer, App Store Connect и подпись приложения для bundle id `ai.clop.ios`.

