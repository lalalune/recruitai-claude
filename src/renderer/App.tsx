import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { toast } from 'sonner';

import { AppShell } from './components/AppShell.js';
import { CommandPalette, ShortcutsOverlay } from './components/CommandPalette.js';
import { EmptyState } from './components/EmptyState.js';
import { Button } from './components/ui/button.js';
import { api, useSendStats, useStats } from './lib/api.js';
import { getTheme, safeLocalGet, safeLocalSet, setTheme } from './lib/utils.js';
import { useUi, type Command, type Screen } from './store/ui.js';

const Review = lazy(() => import('./screens/Review.js'));
const Outreach = lazy(() => import('./screens/Outreach.js'));
const Pipeline = lazy(() => import('./screens/Pipeline.js'));
const Settings = lazy(() => import('./screens/Settings.js'));
const Setup = lazy(() => import('./screens/Setup.js'));

const SETUP_KEY = 'recruitai.setupComplete';

export default function App() {
  const screen = useUi((s) => s.screen);
  const setScreen = useUi((s) => s.setScreen);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const shortcutsOpen = useUi((s) => s.shortcutsOpen);
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen);
  const screenCommands = useUi((s) => s.commands);

  // First run drops straight into Setup; leaving it is what marks it done, so
  // however Setup finishes (finish button, skip, or navigating away) it sticks.
  useEffect(() => {
    if (!safeLocalGet(SETUP_KEY)) setScreen('setup');
  }, [setScreen]);

  useEffect(() => {
    if (screen !== 'setup') safeLocalSet(SETUP_KEY, '1');
  }, [screen]);

  const { data: stats } = useStats({ refetchInterval: 30_000 });
  const { data: sendStats } = useSendStats();

  useHotkeys('mod+k', () => setPaletteOpen(!useUi.getState().paletteOpen), {
    enableOnFormTags: true,
    enableOnContentEditable: true,
    preventDefault: true,
  });

  useHotkeys(
    '?',
    () => setShortcutsOpen(!useUi.getState().shortcutsOpen),
    { useKey: true, preventDefault: true },
    [setShortcutsOpen],
  );

  const globalCommands = useMemo<Command[]>(
    () => [
      ...(['review', 'outreach', 'pipeline', 'settings'] as Screen[]).map((s) => ({
        id: `goto-${s}`,
        label: `Go to ${s.charAt(0).toUpperCase()}${s.slice(1)}`,
        group: 'Navigate',
        keywords: 'open screen',
        run: () => setScreen(s),
      })),
      {
        id: 'theme',
        label: 'Toggle dark / light theme',
        group: 'App',
        run: () => setTheme(getTheme() === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        group: 'App',
        hint: '?',
        run: () => setShortcutsOpen(true),
      },
      {
        id: 'export-companies',
        label: 'Export companies to CSV',
        group: 'Data',
        run: () => exportCsv('companies'),
      },
      {
        id: 'export-contacts',
        label: 'Export contacts to CSV',
        group: 'Data',
        run: () => exportCsv('contacts'),
      },
      {
        id: 'export-drafts',
        label: 'Export drafts to CSV',
        group: 'Data',
        run: () => exportCsv('drafts'),
      },
      {
        id: 'backup',
        label: 'Back up the database now',
        group: 'Data',
        run: () =>
          void api
            .backupNow()
            .then((p) => toast.success('Backup written', { description: p }))
            .catch((e: Error) => toast.error('Backup failed', { description: e.message })),
      },
      {
        id: 'open-data-dir',
        label: 'Open data folder',
        group: 'Data',
        run: () => void api.openDataDir().catch(() => toast.error('Could not open data folder')),
      },
    ],
    [setScreen, setShortcutsOpen],
  );

  const commands = useMemo(
    () => [...screenCommands, ...globalCommands],
    [screenCommands, globalCommands],
  );

  const shellStats = stats
    ? { ...stats, sendToday: sendStats?.today, sendLimit: sendStats?.dailyLimit }
    : undefined;

  const body = (
    <ErrorBoundary key={screen}>
      <Suspense fallback={<ScreenFallback />}>
        {screen === 'review' && <Review />}
        {screen === 'outreach' && <Outreach />}
        {screen === 'pipeline' && <Pipeline />}
        {screen === 'settings' && <Settings />}
        {screen === 'setup' && <Setup />}
      </Suspense>
    </ErrorBoundary>
  );

  return (
    <>
      {screen === 'setup' ? (
        <div className="h-full w-full overflow-auto bg-background text-foreground">{body}</div>
      ) : (
        <AppShell screen={screen} onNavigate={(s) => setScreen(s as Screen)} stats={shellStats}>
          {body}
        </AppShell>
      )}

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <ShortcutsOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}

function exportCsv(what: 'companies' | 'contacts' | 'drafts'): void {
  void api
    .exportCsv(what)
    .then((path) => toast.success(`Exported ${what}`, { description: path }))
    .catch((e: Error) => toast.error('Export failed', { description: e.message }));
}

function ScreenFallback() {
  return (
    <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
      Loading…
    </div>
  );
}

interface BoundaryState {
  error: Error | null;
}

/**
 * A single crashed screen should not take the window with it — the operator may
 * be 3,000 records into a review pass.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Screen crashed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <EmptyState
        title="This screen hit an error"
        description={this.state.error.message}
        action={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              Reload app
            </Button>
          </div>
        }
      />
    );
  }
}
