import * as service from './notifications.service.js';

// Explicit allowlist. claimed_until and other internals never leave the data layer.
function deliveryToResponse(d) {
  return {
    id: d.id,
    incidentId: d.incident_id,
    monitorId: d.monitor_id,
    monitorName: d.monitor_name,
    eventType: d.event_type,
    channel: d.channel,
    status: d.status,
    attemptCount: d.attempt_count,
    lastAttemptAt: d.last_attempt_at,
    sentAt: d.sent_at,
    errorMessage: d.sanitized_error_message,
    createdAt: d.created_at,
  };
}

const prefsToResponse = (p) => ({
  emailOnOpen: p.email_on_open,
  emailOnResolve: p.email_on_resolve,
  updatedAt: p.updated_at,
});

export async function list(req, res) {
  const { limit, offset, status } = req.valid.query;
  const rows = await service.listNotifications(req.user.id, { limit, offset, status });
  res.status(200).json({ data: { notifications: rows.map(deliveryToResponse) }, meta: { limit, offset } });
}

export async function getPrefs(req, res) {
  const prefs = await service.getPreferences(req.user.id);
  res.status(200).json({ data: { preferences: prefsToResponse(prefs) } });
}

export async function patchPrefs(req, res) {
  const prefs = await service.updatePreferences(req.user.id, req.valid.body);
  res.status(200).json({ data: { preferences: prefsToResponse(prefs) } });
}