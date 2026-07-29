import { Keyboard, ListChecks, Moon, Send, Settings as SettingsIcon, Sun, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';

import type { DashboardStats } from '../../shared/ipc.js';
import { num } from '../lib/format.js';
import { cn, type Theme } from '../lib/utils.js';
import { useUi } from '../store/ui.js';

export type ShellStats = DashboardStats & {
  sendToday?: number;
  sendLimit?: number;
  sendThisHour?: number;
  sendHourlyLimit?: number;
};

export interface AppShellProps {
  screen: string;
  onNavigate: (s: string) => void;
  stats?: ShellStats;
  children: ReactNode;
}

const NAV = [
  { key: 'pipeline', label: 'Pipeline', icon: Workflow },
  { key: 'review', label: 'Review', icon: ListChecks },
  { key: 'outreach', label: 'Outreach', icon: Send },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function AppShell({ screen, onNavigate, stats, children }: AppShellProps) {
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen);
  const theme = useUi((s) => s.theme);
  const setThemeChoice = useUi((s) => s.setThemeChoice);

  const cycleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    setThemeChoice(next);
  };

  const reviewed = stats ? `${num(stats.reviewed)} / ${num(stats.companies)} reviewed` : null;
  const sends =
    stats?.sendLimit != null ? `${num(stats.sendToday ?? stats.sent)} / ${num(stats.sendLimit)} today` : null;
  const sendsHour =
    stats?.sendHourlyLimit != null && stats.sendThisHour != null
      ? `${num(stats.sendThisHour)} / ${num(stats.sendHourlyLimit)} this hour`
      : null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[150px] shrink-0 flex-col gap-0.5 border-r border-border bg-surface-2 p-2">
          <div className="mb-2 px-2 pt-1 text-[11px] font-semibold tracking-tight text-muted-foreground">
            recruit<span className="text-primary">AI</span>
          </div>

          {NAV.map((item) => {
            const Icon = item.icon;
            const active = screen === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onNavigate(item.key)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-7 items-center gap-2 rounded-md px-2 text-[13px] transition-colors outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-primary/15 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{item.label}</span>
                {item.key === 'review' && stats && stats.companies - stats.reviewed > 0 && (
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground tabular-nums">
                    {num(stats.companies - stats.reviewed)}
                  </span>
                )}
              </button>
            );
          })}

          <div className="mt-auto flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              className="flex h-7 items-center gap-2 rounded-md px-2 text-[12px] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Keyboard className="size-3.5 shrink-0" />
              <span>Shortcuts</span>
              <kbd className="kbd ml-auto">?</kbd>
            </button>
            <button
              type="button"
              onClick={cycleTheme}
              className="flex h-7 items-center gap-2 rounded-md px-2 text-[12px] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {theme === 'light' ? (
                <Sun className="size-3.5 shrink-0" />
              ) : (
                <Moon className="size-3.5 shrink-0" />
              )}
              <span className="truncate capitalize">{theme}</span>
            </button>
          </div>
        </nav>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
      </div>

      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface-2 px-3 text-[11px] text-muted-foreground">
        {reviewed && <span className="tabular-nums">{reviewed}</span>}
        {stats && (
          <>
            <Dot />
            <span className="tabular-nums">{num(stats.approved)} approved</span>
            <Dot />
            <span className="tabular-nums">
              {num(stats.verifiedContacts)} verified contacts
            </span>
          </>
        )}
        {sends && (
          <>
            <Dot />
            <span className="tabular-nums">{sends}</span>
          </>
        )}
        {sendsHour && (
          <>
            <Dot />
            <span className="tabular-nums">{sendsHour}</span>
          </>
        )}
        {stats && stats.replies > 0 && (
          <>
            <Dot />
            <span className="tabular-nums text-ok">{num(stats.replies)} replies</span>
          </>
        )}
        {stats && stats.bounces > 0 && (
          <>
            <Dot />
            <span className="tabular-nums text-destructive">{num(stats.bounces)} bounces</span>
          </>
        )}
      </footer>

      <Toaster
        position="bottom-right"
        theme={theme}
        closeButton
        toastOptions={{
          classNames: {
            toast:
              'border border-border bg-popover text-popover-foreground text-[12px] rounded-lg shadow-xl',
            description: 'text-muted-foreground',
            actionButton: 'bg-primary text-primary-foreground',
          },
        }}
      />
    </div>
  );
}

function Dot() {
  return <span className="text-border">·</span>;
}
