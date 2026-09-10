import SwiftUI

struct ChatView: View {
    @EnvironmentObject private var session: SessionStore
    @State private var messages: [ChatMessage] = []
    @State private var draft = ""
    @State private var chatID: String?
    @State private var sending = false
    @FocusState private var composerFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if messages.isEmpty { emptyState }
                else { transcript }
                composer
            }
            .background(ClopTheme.background)
            .navigationTitle("Clop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { modelMenu }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 18) {
            Spacer()
            ClopMark(size: 68)
            Text("Чем помочь?")
                .font(.system(size: 28, weight: .bold, design: .rounded))
            Text("Ответы идут напрямую через Clop API\nи учитывают ваш тариф.")
                .multilineTextAlignment(.center)
                .foregroundStyle(ClopTheme.secondary)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
                    ForEach(messages) { message in
                        MessageBubble(message: message).id(message.id)
                    }
                    if sending {
                        HStack(spacing: 10) {
                            ProgressView().tint(ClopTheme.orange)
                            Text("Clop думает…").foregroundStyle(ClopTheme.secondary)
                            Spacer()
                        }
                        .padding(.horizontal)
                    }
                }
                .padding(.vertical, 16)
            }
            .onChange(of: messages.count) { _ in
                if let last = messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Сообщение Clop", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composerFocused)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(ClopTheme.elevated, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.headline)
                    .frame(width: 42, height: 42)
                    .background(canSend ? ClopTheme.orange : Color.white.opacity(0.12), in: Circle())
                    .foregroundStyle(canSend ? .white : Color.white.opacity(0.35))
            }
            .disabled(!canSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(ClopTheme.surface)
    }

    @ToolbarContentBuilder
    private var modelMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                ForEach(session.profile?.models ?? []) { model in
                    Button {
                        guard model.available else { return }
                        session.selectedModel = model.key
                        Task { await session.applyProfile() }
                    } label: {
                        Label(model.title, systemImage: model.available ? (model.key == session.selectedModel ? "checkmark.circle.fill" : "circle") : "lock.fill")
                    }
                    .disabled(!model.available)
                }
            } label: {
                Text(selectedModelTitle)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
        }
    }

    private var selectedModelTitle: String {
        session.profile?.models.first(where: { $0.key == session.selectedModel })?.title ?? "Модель"
    }

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, let token = session.token else { return }
        draft = ""
        composerFocused = false
        messages.append(ChatMessage(role: .user, text: text))
        sending = true
        Task {
            do {
                let response = try await APIClient.shared.chat(
                    token: token,
                    text: text,
                    model: session.selectedModel,
                    effort: session.selectedEffort,
                    fast: session.fast,
                    chatID: chatID
                )
                guard response.ok else { throw ClopAPIError.server(response.error ?? "Ответ не получен.") }
                chatID = response.chatId
                let tokens = response.tokens?.total ?? 0
                let seconds = (response.durationMs ?? 0) / 1000
                messages.append(ChatMessage(
                    role: .assistant,
                    text: response.text ?? "Готово.",
                    meta: tokens > 0 ? "\(tokens.formatted()) ток. · \(seconds.formatted(.number.precision(.fractionLength(1)))) с" : nil
                ))
            } catch {
                messages.append(ChatMessage(role: .assistant, text: "Ошибка: \(error.localizedDescription)"))
            }
            sending = false
        }
    }
}

private struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 48) }
            VStack(alignment: .leading, spacing: 8) {
                Text(message.text).textSelection(.enabled)
                if let meta = message.meta {
                    Text(meta).font(.caption2).foregroundStyle(ClopTheme.secondary)
                }
            }
            .padding(14)
            .background(message.role == .user ? ClopTheme.orangeSoft : ClopTheme.surface,
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            if message.role == .assistant { Spacer(minLength: 34) }
        }
        .padding(.horizontal, 12)
    }
}

