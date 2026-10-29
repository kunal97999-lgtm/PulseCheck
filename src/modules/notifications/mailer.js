import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';

/** Wraps a nodemailer transport. Tests pass their own `{ send }` fake instead. */
export function createMailer(transport = buildTransport()) {
  return {
    send: ({ to, subject, text }) => transport.sendMail({ from: env.MAIL_FROM, to, subject, text }),
    close: () => transport.close?.(),
  };
}

function buildTransport() {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER && { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }),
    connectionTimeout: 10_000, // bounded: a dead SMTP server can't hang a job
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}