/**
 * LinkedIn IPC.
 *
 * The LinkedIn module was fully implemented but unreachable: there was no way
 * for the operator to sign in, so `isAvailable()` was always false and the
 * enrichment source found nothing to do. These three channels are the missing
 * link between the Settings screen and the session.
 *
 * Sign-in deliberately opens a real, visible browser window that the operator
 * drives themselves. The app never handles their password, and a checkpoint or
 * CAPTCHA is surfaced for them to resolve rather than worked around.
 */

import { ipcMain } from 'electron';
import * as linkedin from '../linkedin/index.js';
import type { LinkedInStatus } from '../../shared/ipc.js';

function toStatus(s: Awaited<ReturnType<typeof linkedin.getStatus>>): LinkedInStatus {
  return {
    state: String(s.state),
    available: s.available,
    enabled: s.enabled,
    loggedIn: s.loggedIn,
    message: s.message,
    needsOperator: s.needsOperator,
    day: s.day,
    budgetPerDay: s.budgetPerDay,
    budgetUsed: s.budgetUsed,
    budgetRemaining: s.budgetRemaining,
    nextRequestNotBefore: s.nextRequestNotBefore,
    haltReason: s.haltReason,
    haltAt: s.haltAt,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    inWindow: s.inWindow,
  };
}

export function registerLinkedInIpc(): void {
  ipcMain.handle('getLinkedInStatus', async () => toStatus(await linkedin.getStatus()));

  ipcMain.handle('connectLinkedIn', async () => {
    // Resolves once the operator has actually completed login in the window, or
    // once they close it. Either way the caller gets the real resulting status
    // rather than an optimistic guess.
    await linkedin.openLoginWindow();
    return toStatus(await linkedin.getStatus());
  });

  ipcMain.handle('disconnectLinkedIn', async () => {
    await linkedin.logout();
    return toStatus(await linkedin.getStatus());
  });
}
