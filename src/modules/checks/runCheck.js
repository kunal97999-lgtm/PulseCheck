import { performance } from 'node:perf_hooks';
import { safeRequest } from './httpClient.js';
import { classifyFailure, evaluateStatus } from './classify.js';
import { logger } from '../../utils/logger.js';

/**
 * monitor: { id?, url, timeoutMs, expectedStatusMin, expectedStatusMax }
 * deps:    { lookup?, policy? }  (test seams; production passes nothing)
 *
 * Returns: { checkedAt, success, statusCode, latencyMs, errorType, errorMessage }
 */
export async function runCheck(monitor, deps = {}) {
  const checkedAt = new Date();
  const started = performance.now();

  try {
    const { statusCode, latencyMs } = await safeRequest(monitor.url, {
      timeoutMs: monitor.timeoutMs,
      lookup: deps.lookup,
      policy: deps.policy,
    });
    const verdict = evaluateStatus(statusCode, monitor);
    return {
      checkedAt,
      success: verdict.success,
      statusCode,
      latencyMs,
      errorType: verdict.errorType,
      errorMessage: verdict.message,
    };
  } catch (err) {
    const c = classifyFailure(err);

    // Full detail goes to the log only. The monitor id is enough to find the row.
    if (c.unexpected) {
      logger.error({ err, monitorId: monitor.id }, 'Unclassified check failure');
    } else if (c.errorType === 'blocked') {
      logger.warn({ monitorId: monitor.id, reason: c.detail }, 'Check blocked by SSRF policy');
    }

    return {
      checkedAt,
      success: false,
      statusCode: null,
      // Nothing was sent for a blocked target, so there is no latency to report.
      latencyMs: c.errorType === 'blocked' ? null : Math.round(performance.now() - started),
      errorType: c.errorType,
      errorMessage: c.message,
    };
  }
}