import * as monitorsService from './monitors.service.js';

// Explicit allowlist of response fields, in camelCase. Never return raw DB rows.
function toResponse(m) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    url: m.url,
    intervalSeconds: m.interval_seconds,
    timeoutMs: m.timeout_ms,
    expectedStatus: { min: m.expected_status_min, max: m.expected_status_max },
    failureThreshold: m.failure_threshold,
    recoveryThreshold: m.recovery_threshold,
    isActive: m.is_active,
    status: m.current_status,
    consecutiveFailures: m.consecutive_failures,
    lastCheckedAt: m.last_checked_at,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

export async function create(req, res) {
  const monitor = await monitorsService.createMonitor(req.user.id, req.valid.body);
  res.status(201).json({ data: { monitor: toResponse(monitor) } });
}

export async function getOne(req, res) {
  const monitor = await monitorsService.getMonitor(req.user.id, req.valid.params.id);
  res.status(200).json({ data: { monitor: toResponse(monitor) } });
}

export async function list(req, res) {
  const { limit, offset } = req.valid.query;
  const monitors = await monitorsService.listMonitors(req.user.id, { limit, offset });
  res.status(200).json({
    data: { monitors: monitors.map(toResponse) },
    meta: { limit, offset },
  });
}
