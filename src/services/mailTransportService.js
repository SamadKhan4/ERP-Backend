import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
let transport;
export function mailTransport() {
  transport ||= nodemailer.createTransport(env.SMTP_URL || {
    host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
  return transport;
}
export function passwordLink(token) {
  const url = new URL(env.PASSWORD_RESET_URL || '/reset-password', env.CLIENT_URL.split(',')[0].trim());
  url.search = '';
  url.hash = new URLSearchParams({ token }).toString();
  return url.href;
}
const escape = (text) => String(text).replace(/[&<>"']/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]);
export function welcomeMessage(user, token) {
  const link = passwordLink(token);
  const login = new URL('/login', env.CLIENT_URL.split(',')[0].trim()).href;
  const role = user.role.replaceAll('_', ' ');
  return {
    from: env.MAIL_FROM, to: user.email, subject: 'Welcome to AdBorn ERP — your account is ready',
    text: `Hi ${user.name},\n\nWelcome to AdBorn ERP! Your ${role} account is ready.\nLogin email: ${user.email}\nSet your password within 24 hours: ${link}\nERP login: ${login}\n\nIf this link expires, use Forgot password on the login page.\nAdBorn Solutions`,
    html: `<div style="font-family:Arial,sans-serif;background:#f3f8fd;padding:32px;color:#173958"><div style="max-width:560px;margin:auto;background:white;padding:32px;border-radius:20px"><h2 style="color:#087dda">AdBorn ERP</h2><h1 style="font-size:24px">Welcome, ${escape(user.name)}!</h1><p>Your <strong>${escape(role)}</strong> account is ready.</p><p>Login email: ${escape(user.email)}</p><p style="margin:32px 0"><a href="${escape(link)}" style="background:#087dda;color:white;padding:14px 22px;border-radius:10px;text-decoration:none">Set your password</a></p><p>This secure link expires in 24 hours and can be used once.</p><p><a href="${escape(login)}">Open AdBorn ERP</a></p><p style="font-size:12px;color:#71859a">If the link expires, select Forgot password on the login page. Contact your administrator if this account was unexpected.</p></div></div>`,
  };
}
