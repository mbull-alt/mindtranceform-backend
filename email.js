const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail({ to, subject, html, from = 'Mind Tranceform <hello@mindtranceform.com>' }) {
  const { data, error } = await resend.emails.send({ from, to, subject, html });
  if (error) {
    console.error('[Resend] Send failed:', error);
    throw error;
  }
  return data;
}

// Ready-made emails — call these anywhere in server.js
const emails = {
  welcome: (to, name) =>
    sendEmail({
      to,
      subject: 'Welcome to Mind Tranceform ✨',
      html: `<p>Hi ${name},</p><p>Welcome! Your transformation journey begins now.</p>`,
    }),

  trialEnding: (to, name, daysLeft) =>
    sendEmail({
      to,
      subject: `Your trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      html: `<p>Hi ${name},</p><p>Upgrade now to keep full access to Mind Tranceform.</p>`,
    }),

  paymentReceipt: (to, name, amount) =>
    sendEmail({
      to,
      subject: 'Payment received — thank you!',
      html: `<p>Hi ${name},</p><p>We received your payment of $${amount}. You're all set!</p>`,
    }),

  passwordReset: (to, resetLink) =>
    sendEmail({
      to,
      subject: 'Reset your Mind Tranceform password',
      html: `<p>Click here to reset your password: <a href="${resetLink}">${resetLink}</a></p><p>This link expires in 1 hour.</p>`,
    }),
};

module.exports = { sendEmail, emails };