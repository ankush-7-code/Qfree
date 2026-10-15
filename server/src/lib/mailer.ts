import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Emails "sent" while running tests, for assertions. */
export const testOutbox: Email[] = [];

/** Send an email through Resend. Without RESEND_API_KEY (local development, tests) it is only logged. */
export async function sendEmail(email: Email) {
  if (env.isTest) {
    testOutbox.push(email);
    return;
  }
  if (!env.RESEND_API_KEY) {
    logger.info({ to: email.to, subject: email.subject, text: email.text }, 'Email not sent (RESEND_API_KEY is not set)');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}: ${await res.text()}`);
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A plain, readable email with one button. */
export function simpleEmail(opts: { greeting: string; lines: string[]; button: { label: string; url: string }; footer: string }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f7f6;font-family:Arial,Helvetica,sans-serif;color:#1f2a2a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:22px;font-weight:bold;color:#0f766e;padding-bottom:20px">QFreee</td></tr>
<tr><td style="font-size:16px;line-height:1.5">
<p style="margin:0 0 16px">${escape(opts.greeting)}</p>
${opts.lines.map((l) => `<p style="margin:0 0 16px">${escape(l)}</p>`).join('')}
<p style="margin:24px 0"><a href="${escape(opts.button.url)}" style="background:#0f766e;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:10px;display:inline-block">${escape(opts.button.label)}</a></p>
<p style="margin:0 0 16px;font-size:14px;color:#5b6b6b">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all">${escape(opts.button.url)}</span></p>
<p style="margin:0;font-size:14px;color:#5b6b6b">${escape(opts.footer)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = [opts.greeting, '', ...opts.lines, '', `${opts.button.label}: ${opts.button.url}`, '', opts.footer].join('\n');
  return { html, text };
}
