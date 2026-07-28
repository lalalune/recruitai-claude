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
  'listDrafts', 'generateDraft', 'patchDraft', 'queueDraft', 'skipDraft', 'sendNow',
  'getSendStats', 'startSending', 'pauseSending', 'listInbound', 'markInbound', 'syncInbox',
  'getLinkedInStatus', 'connectLinkedIn', 'disconnectLinkedIn',
  'getSettings', 'patchSettings', 'setSecret', 'testKey', 'connectGmail', 'disconnectGmail', 'testGmail',
  'listSuppressions', 'addSuppression', 'removeSuppression', 'importSuppressionsCsv',
  'getStats', 'exportCsv', 'backupNow', 'openDataDir', 'openExternal', 'getScreenshot',
] as const;

let registered = false;

export function registerIpc(win: BrowserWindow): void {
  // The dev watcher can re-enter this; ipcMain.handle throws on a duplicate.
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);

  setDataDir(dataDir());
  setPipelineWindow(win);

  registerCompanyIpc();
  registerPipelineIpc();
  registerOutreachIpc();
  registerLinkedInIpc();
  registerSettingsIpc();

  if (!registered) {
    registered = true;
    win.on('closed', () => {
      pauseSending(getDb());
      setPipelineWindow(null);
    });
  }

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
