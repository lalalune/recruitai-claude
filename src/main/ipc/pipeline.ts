/**
 * Pipeline IPC.
 *
 * `runSource` and `runAll` deliberately return as soon as the run is accepted.
 * A full sweep is measured in minutes; holding an IPC promise open for that long
 * would make the renderer look hung, and progress already streams over
 * 'pipeline:progress' and 'pipeline:log'.
 */

import { ipcMain } from 'electron';
import { appendLog, getPipelineState, runAll, runSource, setSourceEnabled, stopPipeline } from '../pipeline/run.js';
import type { SourceKey } from '../../shared/ipc.js';

const VALID_KEYS = new Set<SourceKey>([
  'yc',
  'ats_sweep',
  'careers_crawl',
  'hn_whoishiring',
  'sec_formd',
  'linkedin',
  'contact_discovery',
  'email_verify',
  'scoring',
  'draft_generation',
]);

function assertKey(key: unknown): SourceKey {
  if (typeof key !== 'string' || !VALID_KEYS.has(key as SourceKey)) {
    throw new Error(`Unknown pipeline source: ${String(key)}`);
  }
  return key as SourceKey;
}

export function registerPipelineIpc(): void {
  ipcMain.handle('getPipeline', async () => getPipelineState());

  ipcMain.handle('runSource', async (_e, key: SourceKey) => {
    const source = assertKey(key);
    void runSource(source).catch((err) => {
      appendLog(source, 'error', err instanceof Error ? err.message : String(err));
    });
  });

  ipcMain.handle('runAll', async () => {
    void runAll().catch((err) => {
      appendLog('pipeline', 'error', err instanceof Error ? err.message : String(err));
    });
  });

  ipcMain.handle('stopPipeline', async () => {
    stopPipeline();
  });

  ipcMain.handle('setSourceEnabled', async (_e, key: SourceKey, enabled: boolean) => {
    setSourceEnabled(assertKey(key), enabled === true);
  });
}
