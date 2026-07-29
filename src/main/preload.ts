/**
 * contextBridge surface. The renderer gets exactly the methods declared in
 * RecruitApi (src/shared/ipc.ts) and nothing else — no ipcRenderer, no Node.
 */
import { contextBridge, ipcRenderer } from 'electron';

const METHODS = [
  'listCompanies','getCompany','patchCompany','bulkCompanyStatus','resolveConflict',
  'patchContact','addContact','deleteContact','findContacts','verifyContact',
  'getPipeline','runSource','runAll','stopPipeline','setSourceEnabled',
  'listDrafts','generateDraft','patchDraft','queueDraft','unqueueDraft','skipDraft','sendNow','sendTestEmail',
  'getSendStats','startSending','pauseSending','listInbound','markInbound','syncInbox','listSent','getPerformance','generateFollowUp',
  'getLinkedInStatus','connectLinkedIn','disconnectLinkedIn',
  'getSettings','patchSettings','setSecret','testKey','connectGmail','disconnectGmail','testGmail','setGmailClient',
  'listSuppressions','addSuppression','removeSuppression','importSuppressionsCsv',
  'getStats','exportCsv','backupNow','openDataDir','openExternal','getScreenshot',
] as const;

const EVENTS = [
  'pipeline:progress','pipeline:log','send:progress','data:changed','gmail:needs-reauth',
] as const;

const api = Object.fromEntries(
  METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(m, ...args)]),
) as Record<string, (...args: unknown[]) => Promise<unknown>>;

api.on = ((event: string, cb: (payload: unknown) => void) => {
  if (!(EVENTS as readonly string[]).includes(event)) return () => {};
  const handler = (_e: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(event, handler);
  return () => ipcRenderer.removeListener(event, handler);
}) as never;

contextBridge.exposeInMainWorld('api', api);
