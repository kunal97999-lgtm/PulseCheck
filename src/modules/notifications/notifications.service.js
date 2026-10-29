import * as queries from './notifications.queries.js';

export function listNotifications(userId, filters) {
  return queries.listForUser(userId, filters);
}

export async function getPreferences(userId) {
  // No row means "both on": the same default the outbox writer uses.
  return (await queries.getPreferences(userId)) ?? {
    email_on_open: true,
    email_on_resolve: true,
    updated_at: null,
  };
}

export function updatePreferences(userId, patch) {
  return queries.upsertPreferences(userId, patch);
}