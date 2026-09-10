import SwiftUI
import UniformTypeIdentifiers

struct CloudView: View {
    @EnvironmentObject private var session: SessionStore
    @State private var summary: CloudSummary?
    @State private var loading = false
    @State private var importing = false
    @State private var notice: String?

    var body: some View {
        NavigationStack {
            Group {
                if let summary {
                    List {
                        Section { quotaCard(summary) }
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                        Section("Файлы") {
                            if summary.files.isEmpty {
                                EmptyCloudView(
                                    title: "Облако пустое",
                                    text: "Добавьте фото, документ или резервную копию чатов."
                                )
                                    .listRowBackground(Color.clear)
                            }
                            ForEach(summary.files) { file in
                                fileRow(file)
                            }
                            .onDelete(perform: delete)
                        }
                    }
                    .scrollContentBackground(.hidden)
                } else if loading {
                    ProgressView("Загружаю облако…").tint(ClopTheme.orange)
                } else {
                    EmptyCloudView(title: "Нет данных", text: "Потяните вниз или повторите загрузку.", icon: "exclamationmark.icloud")
                }
            }
            .background(ClopTheme.background)
            .navigationTitle("Облако")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Загрузить файл", systemImage: "square.and.arrow.up") { importing = true }
                        Button("Копия чатов", systemImage: "archivebox") { Task { await runAction(.backup) } }
                        Button("Оптимизировать", systemImage: "wand.and.stars") { Task { await runAction(.optimize) } }
                    } label: { Image(systemName: "plus.circle.fill") }
                }
            }
            .refreshable { await load() }
            .task { await load() }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
                Task { await upload(result) }
            }
            .overlay(alignment: .bottom) {
                if let notice {
                    Text(notice)
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding(.bottom, 14)
                }
            }
        }
    }

    private func quotaCard(_ value: CloudSummary) -> some View {
        ClopCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("Хранилище", systemImage: "internaldrive.fill")
                        .font(.headline)
                    Spacer()
                    Text("\(value.percent.formatted(.number.precision(.fractionLength(0...1))))%")
                        .foregroundStyle(ClopTheme.secondary)
                }
                ProgressView(value: min(value.percent, 100), total: 100).tint(ClopTheme.orange)
                Text("\(format(value.usedBytes)) из \(format(value.quotaBytes))")
                    .font(.footnote).foregroundStyle(ClopTheme.secondary)
            }
        }
    }

    private func fileRow(_ file: CloudFile) -> some View {
        HStack(spacing: 12) {
            Image(systemName: file.mime.hasPrefix("image/") ? "photo.fill" : (file.kind == "chat-backup" ? "archivebox.fill" : "doc.fill"))
                .foregroundStyle(ClopTheme.orange)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text(file.name).lineLimit(1)
                Text("\(format(file.size)) · \(date(file.createdAt))")
                    .font(.caption).foregroundStyle(ClopTheme.secondary)
            }
        }
        .listRowBackground(ClopTheme.surface)
    }

    private func load() async {
        guard let token = session.token else { return }
        loading = true
        do { summary = try await APIClient.shared.storage(token: token) }
        catch { session.errorMessage = error.localizedDescription }
        loading = false
    }

    private func upload(_ result: Result<URL, Error>) async {
        guard let token = session.token else { return }
        do {
            let url = try result.get()
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            summary = try await APIClient.shared.upload(token: token, name: url.lastPathComponent, mime: mime, data: data)
            show("Файл сохранён")
        } catch { session.errorMessage = error.localizedDescription }
    }

    private func delete(at offsets: IndexSet) {
        guard let token = session.token, let files = summary?.files else { return }
        for index in offsets {
            let id = files[index].id
            Task {
                do { summary = try await APIClient.shared.delete(token: token, id: id) }
                catch { session.errorMessage = error.localizedDescription }
            }
        }
    }

    private enum Action { case backup, optimize }
    private func runAction(_ action: Action) async {
        guard let token = session.token else { return }
        do {
            switch action {
            case .backup:
                summary = try await APIClient.shared.backup(token: token)
                show("Копия чатов создана")
            case .optimize:
                summary = try await APIClient.shared.optimize(token: token)
                show("Облако оптимизировано")
            }
        } catch { session.errorMessage = error.localizedDescription }
    }

    private func show(_ value: String) {
        notice = value
        Task {
            try? await Task.sleep(for: .seconds(2))
            if notice == value { notice = nil }
        }
    }

    private func format(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private func date(_ milliseconds: Double) -> String {
        Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}

private struct EmptyCloudView: View {
    let title: String
    let text: String
    var icon = "icloud"

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 36)).foregroundStyle(ClopTheme.secondary)
            Text(title).font(.headline)
            Text(text).font(.subheadline).multilineTextAlignment(.center).foregroundStyle(ClopTheme.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
    }
}

