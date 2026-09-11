import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'clop-mail-test-'));
process.env.CLOP_DATA_DIR = temp;
process.env.MAIL_PUBLIC_DOMAIN = 'mail.example.test';
const plans = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const providers = ['claude', 'gpt', 'kimi', 'clop'];
process.env.TOKEN_LIMITS_JSON = JSON.stringify(Object.fromEntries(plans.map((plan) => [
  plan,
  Object.fromEntries(providers.map((provider) => [provider, { short: 1000, long: 10_000 }])),
])));

const store = await import('../src/store.js');
const mail = await import('../src/clop-mail.js');
await store.load();

test('mail plans expose the requested mailbox and storage limits', () => {
  const gib = 1024 ** 3;
  assert.deepEqual(mail.mailPolicy('free'), { mailboxes: 2, storageBytes: 10 * gib });
  assert.deepEqual(mail.mailPolicy('go'), { mailboxes: 5, storageBytes: 20 * gib });
  assert.deepEqual(mail.mailPolicy('pro'), { mailboxes: 10, storageBytes: 40 * gib });
  assert.deepEqual(mail.mailPolicy('max'), { mailboxes: 15, storageBytes: 50 * gib });
  assert.deepEqual(mail.mailPolicy('max20'), { mailboxes: 25, storageBytes: 50 * gib });
  assert.deepEqual(mail.mailPolicy('coderplus'), { mailboxes: 100, storageBytes: 100 * gib });
});

test('free accounts can create two globally unique mailboxes', () => {
  const first = store.getUser({ id: 81001, first_name: 'First' });
  const second = store.getUser({ id: 81002, first_name: 'Second' });
  assert.equal(mail.createMailbox(first, 'alpha', 'free').ok, true);
  assert.equal(mail.createMailbox(first, 'beta@clop', 'free').ok, true);
  assert.equal(mail.createMailbox(first, 'third', 'free').reason, 'limit');
  assert.equal(mail.createMailbox(second, 'alpha', 'free').reason, 'taken');
  assert.equal(mail.publicAddress('alpha@clop'), 'alpha@mail.example.test');
  assert.equal(mail.shortAddress('alpha@mail.example.test'), 'alpha@clop');
});

test('internal and internet mail are stored, readable and removable by their owners', async () => {
  const sender = store.findUser('81001');
  const recipient = store.getUser({ id: 81003, first_name: 'Recipient' });
  mail.createMailbox(recipient, 'receiver', 'free');
  const result = await mail.deliverInternal({
    fromUser: sender, from: 'alpha@clop', to: 'receiver@clop', subject: 'Hello', text: 'Clop mail works',
    attachments: [{ filename: 'note.txt', contentType: 'text/plain', content: Buffer.from('attachment') }],
  });
  assert.equal(result.ok, true);
  assert.equal(mail.mailState(recipient, 'free').unread, 1);
  assert.ok(mail.storageUsed(sender) > 0);
  assert.ok(mail.storageUsed(recipient) > 0);
  assert.equal(mail.getMessage(recipient, result.message.id).readAt > 0, true);
  const attachment = await mail.attachmentData(recipient, result.message.id, 0);
  assert.equal(attachment.content.toString(), 'attachment');

  const external = await mail.deliverExternal({ from: 'person@example.com', to: 'receiver@mail.example.test', subject: 'Outside', text: 'From internet' });
  assert.equal(external.ok, true);
  assert.equal(mail.inbox(recipient).length, 2);
  assert.equal(await mail.deleteMessage(recipient, external.message.id), true);
  assert.equal(mail.inbox(recipient).length, 1);
});

test.after(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});
