import { NotFoundError } from '../../utils/errors.js';
import * as queries from './incidents.queries.js';
import * as monitorsRepo from '../monitors/monitors.repository.js';

export function listIncidents(userId, filters) {
  return queries.listForUser(userId, filters);
}

export async function getIncident(userId, incidentId) {
  const incident = await queries.findByIdForUser(incidentId, userId);
  if (!incident) throw new NotFoundError('Incident not found');
  return incident;
}

export async function listMonitorIncidents(userId, monitorId, filters) {
  const monitor = await monitorsRepo.findByIdForUser(monitorId, userId);
  if (!monitor) throw new NotFoundError('Monitor not found');
  return queries.listForUser(userId, { ...filters, monitorId });
}