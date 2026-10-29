import * as service from './incidents.service.js';

// Explicit allowlist of response fields. Never return raw DB rows.
function toResponse(i) {
  return {
    id: i.id,
    monitorId: i.monitor_id,
    monitorName: i.monitor_name,
    status: i.status,
    firstFailedAt: i.first_failed_at,
    startedAt: i.started_at,
    resolvedAt: i.resolved_at,
    resolutionReason: i.resolution_reason,
    failureType: i.failure_type,
    failureReason: i.failure_reason,
    durationSeconds: i.duration_seconds,
  };
}

export async function list(req, res) {
  const { limit, offset, status, monitorId } = req.valid.query;
  const rows = await service.listIncidents(req.user.id, { limit, offset, status, monitorId });
  res.status(200).json({ data: { incidents: rows.map(toResponse) }, meta: { limit, offset } });
}

export async function getOne(req, res) {
  const incident = await service.getIncident(req.user.id, req.valid.params.id);
  res.status(200).json({ data: { incident: toResponse(incident) } });
}

export async function listForMonitor(req, res) {
  const { limit, offset, status } = req.valid.query;
  const rows = await service.listMonitorIncidents(req.user.id, req.valid.params.id, {
    limit,
    offset,
    status,
  });
  res.status(200).json({ data: { incidents: rows.map(toResponse) }, meta: { limit, offset } });
}