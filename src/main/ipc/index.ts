/**
 * Single registration point for the IPC surface.
 *
 * Every channel name matches a method on RecruitApi exactly; the preload bridge
 * builds `window.api` from the same list, so a typo shows up as a missing
 * handler at startup rather than a silent no-op at runtime.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { getDb } from '../db/index.js';
import { dataDir } from '../index.js';
import { setDataDir } from '../settings.js';
import { setPipelineWindow, recoverAfterRestart, appendLog } from '../pipeline/run.js';
import { setGmailEventSink } from '../gmail/oauth.js';
import { registerCompanyIpc } from './companies.js';
import { registerPipelineIpc } from './pipeline.js';
import { registerOutreachIpc, reconcileInterruptedSends, pauseSending } from './outreach.js';
import { registerLinkedInIpc } from './linkedin.js';
import { registerSettingsIpc } from './settings.js';

/** Mirrors the METHODS list in preload.ts. Kept explicit so both sides drift loudly. */
const CHANNELS = [
  'listCompanies', 'getCompany', 'patchCompany', 'bulkCompanyStatus', 'resolveConflict',
  'patchContact', 'addContact', 'deleteContact', 'findContacts', 'verifyContact',
  'getPipeline', 'runSource', 'runAll', 'stopPipeline', 'setSourceEnabled',
  'listDrafts', 'generateDraft', 'patchDraft', 'queueDraft', 'unqueueDraft', 'skipDraft', 'sendNow', 'sendTestEmail',
  'getSendStats', 'startSending', 'pauseSending', 'listInbound', 'markInbound', 'syncInbox', 'listSent', 'getPerformance', 'generateFollowUp',
  'getLinkedInStatus', 'connectLinkedIn', 'disconnectLinkedIn',
  'getSettings', 'patchSettings', 'setSecret', 'testKey', 'connectGmail', 'disconnectGmail', 'testGmail',
  'listSuppressions', 'addSuppression', 'removeSuppression', 'importSuppressionsCsv',
  'getStats', 'exportCsv', 'backupNow', 'openDataDir', 'openExternal', 'getScreenshot',
] as const;

/** Windows already carrying the closed-hook — the dev watcher re-enters
 *  registerIpc and stacked a duplicate pause/unwire listener per reload. */
const wiredWindows = new WeakSet<BrowserWindow>();

let bootstrapped = false;

/**
 * Point progress/log events at a window and pause sending when it closes.
 * Called for every window we create — including macOS dock re-activation,
 * which builds a new BrowserWindow long after registerIpc ran.
 */
export function wireWindow(win: BrowserWindow): void {
  setPipelineWindow(win);
  // Gmail events (needs-reauth) go to this window only — the fallback
  // broadcast would also reach the LinkedIn login/worker windows.
  setGmailEventSink((channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  });
  if (wiredWindows.has(win)) return;
  wiredWindows.add(win);
  win.on('closed', () => {
    try {
      pauseSending(getDb());
    } catch {
      /* quitting: before-quit already paused and closed the db */
    }
    setPipelineWindow(null);
    setGmailEventSink(null);
  });
}

export function registerIpc(win: BrowserWindow): void {
  // The dev watcher can re-enter this; ipcMain.handle throws on a duplicate.
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);

  setDataDir(dataDir());
  wireWindow(win);

  registerCompanyIpc();
  registerPipelineIpc();
  registerOutreachIpc();
  registerLinkedInIpc();
  registerSettingsIpc();

  // Once per process. The dev watcher re-enters registerIpc; reconciling again
  // mid-session would mark a genuinely in-flight send as failed.
  if (bootstrapped) return;
  bootstrapped = true;

  recoverAfterRestart();

  const interrupted = reconcileInterruptedSends(getDb());
  if (interrupted > 0) {
    appendLog(
      'sender',
      'warn',
      `${interrupted} send${interrupted === 1 ? '' : 's'} were interrupted by a previous shutdown and are marked failed. ` +
        `Check Gmail's Sent folder before requeueing — they are never resent automatically.`,
    );
  }
}
