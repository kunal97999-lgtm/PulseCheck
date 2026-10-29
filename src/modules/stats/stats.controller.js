import * as service from './stats.service.js';

export async function getStats(req, res) {
  const s = await service.getMonitorStats(req.user.id, req.valid.params.id, req.valid.query);
  res.status(200).json({ data: { stats: s } });
}