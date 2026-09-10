import SwiftUI

enum ClopTheme {
    static let orange = Color(red: 1.0, green: 0.45, blue: 0.20)
    static let orangeSoft = Color(red: 0.84, green: 0.30, blue: 0.13)
    static let background = Color(red: 0.055, green: 0.047, blue: 0.043)
    static let surface = Color(red: 0.105, green: 0.090, blue: 0.080)
    static let elevated = Color(red: 0.145, green: 0.125, blue: 0.110)
    static let secondary = Color.white.opacity(0.62)
}

struct ClopMark: View {
    var size: CGFloat = 56

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [Color(red: 1, green: 0.59, blue: 0.29), ClopTheme.orangeSoft],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .shadow(color: ClopTheme.orange.opacity(0.35), radius: size * 0.18)
            HStack(spacing: size * 0.13) {
                Capsule().fill(.white).frame(width: size * 0.13, height: size * 0.28)
                Capsule().fill(.white).frame(width: size * 0.13, height: size * 0.28)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Clop")
    }
}

struct ClopCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(16)
            .background(ClopTheme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            }
    }
}
