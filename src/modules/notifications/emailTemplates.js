/** Strips control characters (header injection) and bounds the length. */
function line(value, max = 100) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Host only: paths and query strings can carry tokens. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}

export function buildEmail({ eventType, monitorName, url, startedAt, resolvedAt, failureType, failureReason }) {
  const name = line(monitorName) || 'Unnamed monitor';
  const host = hostOf(url);

  if (eventType === 'incident_resolved') {
    const minutes = resolvedAt
      ? Math.max(0, Math.round((new Date(resolvedAt) - new Date(startedAt)) / 60000))
      : null;
    return {
      subject: `[PulseCheck] RECOVERED: ${name}`,
      text: [
        `${name} (${host}) is back up.`,
        '',
        `Incident started:  ${new Date(startedAt).toISOString()}`,
        `Recovered at:      ${resolvedAt ? new Date(resolvedAt).toISOString() : 'unknown'}`,
        ...(minutes !== null ? [`Duration:          about ${minutes} minute(s)`] : []),
      ].join('\n'),
    };
  }

  return {
    subject: `[PulseCheck] DOWN: ${name}`,
    text: [
      `${name} (${host}) is failing its health checks.`,
      '',
      `Incident started:  ${new Date(startedAt).toISOString()}`,
      `Failure type:      ${line(failureType) || 'unknown'}`,
      `Reason:            ${line(failureReason, 200) || 'unknown'}`,
    ].join('\n'),
  };
}