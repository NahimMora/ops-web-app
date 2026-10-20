import nodemailer from "nodemailer";
import { monitorConfig } from "./config.js";
import type { Mail } from "./evaluate.js";

export async function sendMail(mail: Mail): Promise<void> {
  const { host, port, user, password, to } = monitorConfig.smtp;
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass: password }, connectionTimeout: 20_000, socketTimeout: 30_000 });
  try {
    await transport.sendMail({ from: `"HolaSalta Monitor" <${user}>`, to, subject: mail.subject, text: mail.text });
  } finally {
    transport.close();
  }
}
