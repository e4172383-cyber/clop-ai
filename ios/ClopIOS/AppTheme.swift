import SwiftUI

enum ClopTheme {
    static let orange = Color(red: 0.843, green: 0.514, blue: 0.369)
    static let orangeSoft = Color(red: 0.678, green: 0.408, blue: 0.302)
    static let background = Color(red: 0.090, green: 0.082, blue: 0.075)
    static let surface = Color(red: 0.137, green: 0.125, blue: 0.114)
    static let elevated = Color(red: 0.184, green: 0.165, blue: 0.145)
    static let secondary = Color(red: 0.780, green: 0.731, blue: 0.682)
}

struct ClopMark: View {
    var size: CGFloat = 56

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
                .fill(ClopTheme.orange)
            Text("C")
                .font(.system(size: size * 0.52, weight: .bold, design: .rounded))
                .foregroundStyle(ClopTheme.background)
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
            .padding(20)
            .background(ClopTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.white.opacity(0.12), lineWidth: 1)
            }
    }
}
