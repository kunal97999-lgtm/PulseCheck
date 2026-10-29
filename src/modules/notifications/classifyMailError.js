const NETWORK_CODES = new Set([
  'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET', 'EDNS', 'ENOTFOUND', 'EAI_AGAIN',
]);

/**
 * Maps a nodemailer/SMTP error to { permanent, message }.
 * `message` is a FIXED string safe to store: raw SMTP errors contain addresses and banners.
 * Unknown errors are transient, which is safe because attempts are bounded.
 */
export function classifyMailError(err) {
  const code = typeof err?.code === 'string' ? err.code : null;
  const rc = Number.isInteger(err?.responseCode) ? err.responseCode : null;

  // A credentials problem is an operator fix, not a bad recipient: retry, bounded.
  if (code === 'EAUTH') return { permanent: false, message: 'Email provider authentication failed' };
  if (code === 'EENVELOPE') return { permanent: true, message: 'Recipient address was rejected' };
  if (rc !== null && rc >= 400 && rc < 500) return { permanent: false, message: 'Email provider asked to retry later' };
  if (rc !== null && rc >= 500 && rc < 600) return { permanent: true, message: 'Email provider rejected the message' };
  if (code && NETWORK_CODES.has(code)) return { permanent: false, message: 'Could not reach the email provider' };
  return { permanent: false, message: 'Email delivery failed' };
}