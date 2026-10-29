import * as service from './history.service.js';

function toResponse(c) {
  return {
    scheduledFor: c.scheduled_for,
    checkedAt: c.checked_at,
    success: c.success,
    statusCode: c.status_code,
    latencyMs: c.latency_ms,
    errorType: c.error_type,
    errorMessage: c.error_message,
  };
}

export async function listChecks(req, res) {
  const { checks, nextCursor } = await service.listHistory(
    req.user.id, req.valid.params.id, req.valid.query,
  );
  res.status(200).json({
    data: { checks: checks.map(toResponse) },
    meta: { limit: req.valid.query.limit, nextCursor },
  });
}