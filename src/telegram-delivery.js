export async function deliverFinalMessage(telegram, chatId, placeholderId, text, previewEdit = Promise.resolve()) {
  await previewEdit;
  const parts = telegram.chunkText(text);
  if (!parts.length) return;
  let firstUnsent = 0;
  if (placeholderId) {
    const edited = await telegram.editMessage(chatId, placeholderId, parts[0]);
    if (edited) firstUnsent = 1;
  }
  for (let i = firstUnsent; i < parts.length; i++) {
    await telegram.sendMessage(chatId, parts[i]);
  }
}
