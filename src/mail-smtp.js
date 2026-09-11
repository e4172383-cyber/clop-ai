import dns from 'node:dns/promises';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { MAIL_MAX_ATTACHMENT_BYTES, MAIL_PUBLIC_DOMAIN, deliverExternal, mailboxByAddress, publicAddress, recordExternalSent, shortAddress, updateOutboundStatus } from './clop-mail.js';

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
let server = null;

function smtpError(message, responseCode = 550) {
  const error = new Error(message);
  error.responseCode = responseCode;
  return error;
}

export function startMailSmtp({ port = Number(process.env.SMTP_PORT || 0), host = process.env.SMTP_HOST || '0.0.0.0', notify } = {}) {
  if (!port || server) return server;
  server = new SMTPServer({
    name: MAIL_PUBLIC_DOMAIN,
    banner: 'Clop Mail',
    authOptional: true,
    disabledCommands: ['AUTH'],
    hideSTARTTLS: true,
    size: MAX_MESSAGE_BYTES,
    onMailFrom(_address, _session, callback) { callback(); },
    onRcptTo(address, _session, callback) {
      if (!mailboxByAddress(address.address)) return callback(smtpError('Mailbox unavailable'));
      callback();
    },
    async onData(stream, session, callback) {
      try {
        const parsed = await simpleParser(stream, { skipImageLinks: true, maxHtmlLengthToParse: 2_000_000 });
        const from = parsed.from?.value?.[0]?.address || session.envelope.mailFrom?.address || 'unknown';
        const subject = parsed.subject || 'Без темы';
        const text = String(parsed.text || '').trim() || 'Письмо без текстового содержимого.';
        const attachments = (parsed.attachments || []).map((item) => ({
          filename: item.filename, contentType: item.contentType, size: item.size, content: item.content,
        }));
        if (attachments.some((item) => item.size > MAIL_MAX_ATTACHMENT_BYTES)) throw smtpError('Attachment too large', 552);
        const delivered = [];
        for (const target of session.envelope.rcptTo) {
          const result = await deliverExternal({ from, to: target.address, subject, text, attachments });
          if (!result.ok) throw smtpError(result.reason === 'recipient_storage' ? 'Mailbox storage full' : 'Mailbox unavailable', result.reason === 'recipient_storage' ? 452 : 550);
          delivered.push(result);
        }
        for (const item of delivered) await notify?.(item.message, item.recipient);
        callback();
      } catch (error) {
        callback(error.responseCode ? error : smtpError('Message rejected', 451));
      }
    },
    onError(error) { console.error('[mail] SMTP:', error.message); },
  });
  server.listen(port, host, () => console.log(`[mail] SMTP: ${host}:${port} · домен ${MAIL_PUBLIC_DOMAIN}`));
  return server;
}

export async function stopMailSmtp() {
  if (!server) return;
  const current = server;
  server = null;
  await new Promise((resolve) => current.close(() => resolve()));
}

function validInternetAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  if (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
  return address;
}

async function mxHosts(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority).map((item) => item.exchange).filter(Boolean);
  } catch {
    const addresses = await dns.resolve4(domain);
    return addresses;
  }
}

export async function sendInternetMail({ fromUser, from, to, subject, text, attachments = [] }) {
  const recipient = validInternetAddress(to);
  if (!recipient) return { ok: false, reason: 'recipient' };
  if (shortAddress(recipient)) return { ok: false, reason: 'internal' };
  const senderBox = mailboxByAddress(from);
  if (!senderBox || String(senderBox.ownerId) !== String(fromUser.id)) return { ok: false, reason: 'sender' };
  const sentCopy = await recordExternalSent({ fromUser, from, to: recipient, subject, text, attachments });
  if (!sentCopy) return { ok: false, reason: 'sender_storage' };
  const domain = recipient.slice(recipient.lastIndexOf('@') + 1);
  let hosts = [];
  try { hosts = await mxHosts(domain); }
  catch (error) {
    await updateOutboundStatus(sentCopy.id, 'failed', error.message);
    return { ok: false, reason: 'delivery', error: String(error.message || error).slice(0, 240) };
  }
  let lastError = null;
  for (const host of hosts.slice(0, 4)) {
    const transport = nodemailer.createTransport({
      host, port: 25, secure: false, name: MAIL_PUBLIC_DOMAIN,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      tls: { rejectUnauthorized: false },
    });
    try {
      const info = await transport.sendMail({
        envelope: { from: publicAddress(from), to: recipient },
        from: `Clop Mail <${publicAddress(from)}>`, to: recipient,
        subject: String(subject || 'Без темы').slice(0, 120), text: String(text || '').slice(0, 20_000),
        attachments: attachments.map((item) => ({ filename: item.filename, contentType: item.contentType, content: item.content })),
      });
      transport.close();
      await updateOutboundStatus(sentCopy.id, 'sent');
      return { ok: true, info, message: sentCopy };
    } catch (error) {
      lastError = error;
      transport.close();
    }
  }
  await updateOutboundStatus(sentCopy.id, 'failed', lastError?.message || 'SMTP delivery failed');
  return { ok: false, reason: 'delivery', error: String(lastError?.message || 'SMTP delivery failed').slice(0, 240) };
}
