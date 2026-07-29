import { Command as Cmdk } from 'cmdk';
import { useMemo, useState } from 'react';

import { cn, MOD } from '../lib/utils.js';
import type { Command } from '../store/ui.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog.js';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
}

export function CommandPalette({ open, onOpenChange, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const byGroup = new Map<string, Command[]>();
    for (const c of commands) {
      const g = c.group ?? 'Actions';
      const list = byGroup.get(g);
      if (list) list.push(c);
      else byGroup.set(g, [c]);
    }
    return [...byGroup.entries()];
  }, [commands]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setQuery('');
        onOpenChange(o);
      }}
    >
      <DialogContent
        className="top-[18%] max-w-[560px] translate-y-0 overflow-hidden p-0"
        showClose={false}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search and run any action in the app.
        </DialogDescription>
        <Cmdk
          loop
          className="flex flex-col"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onOpenChange(false);
          }}
        >
          <Cmdk.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Type a command…"
            className="h-11 w-full border-b border-border bg-transparent px-4 text-[13px] outline-none placeholder:text-muted-foreground/70"
          />
          <Cmdk.List className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
            <Cmdk.Empty className="px-3 py-6 text-center text-[12px] text-muted-foreground">
              No matching command.
            </Cmdk.Empty>
            {groups.map(([group, items]) => (
              <Cmdk.Group
                key={group}
                heading={group}
                className="mb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
              >
                {items.map((c) => (
                  <Cmdk.Item
                    key={c.id}
                    value={`${c.label} ${c.keywords ?? ''} ${group}`}
                    disabled={c.disabled}
                    onSelect={() => {
                      onOpenChange(false);
                      setQuery('');
                      c.run();
                    }}
                    className={cn(
                      'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] outline-none',
                      'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
                      'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45',
                    )}
                  >
                    <span className="truncate">{c.label}</span>
                    {c.hint && <kbd className="kbd ml-auto">{c.hint}</kbd>}
                  </Cmdk.Item>
                ))}
              </Cmdk.Group>
            ))}
          </Cmdk.List>
        </Cmdk>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Navigate',
    items: [
      ['j / k', 'Next / previous record'],
      ['↑ / ↓', 'Next / previous record'],
      ['space', 'Peek focused record (no advance)'],
      ['/', 'Focus search'],
      ['1 – 5', 'Switch filter'],
      ['s', 'Cycle sort'],
    ],
  },
  {
    group: 'Decide',
    items: [
      ['a', 'Approve and advance'],
      ['x', 'Reject and advance'],
      ['r', 'Toggle reviewed'],
      ['c', 'Compose email'],
      ['f', 'Find more contacts'],
      ['v', 'Re-verify emails'],
      ['g', 'Open evidence lightbox'],
    ],
  },
  {
    group: 'Edit',
    items: [
      ['e', 'Edit focused field'],
      ['tab / shift+tab', 'Next / previous field'],
      ['enter', 'Commit edit'],
      ['esc', 'Cancel edit'],
      [`${MOD}+Z`, 'Undo last action'],
    ],
  },
  {
    group: 'Global',
    items: [
      [`${MOD}+K`, 'Command palette'],
      ['?', 'This overlay'],
      ['shift+click', 'Range-select rows'],
      [`${MOD}+click`, 'Toggle row selection'],
    ],
  },
  // Outreach binds its own keys per tab. They were live but undocumented, which
  // is how `n` (suppress the domain, on Replies) stayed invisible next to `n`
  // (next draft, on Drafts).
  {
    group: 'Outreach · drafts',
    items: [
      [`${MOD}+↵`, 'Queue for sending'],
      ['s', 'Skip this draft'],
      ['x', 'Reject the company'],
      ['n', 'Next draft'],
    ],
  },
  {
    group: 'Outreach · queue & replies',
    items: [
      ['j / k', 'Move through the queue'],
      ['x', 'Return the queued draft to Drafts'],
      ['p', 'Reply: mark positive'],
      ['n', 'Reply: mark negative (suppresses the domain)'],
      ['b', 'Reply: confirm bounce'],
      ['o', 'Reply: open the thread in Gmail'],
    ],
  },
];

export interface ShortcutsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutsOverlay({ open, onOpenChange }: ShortcutsOverlayProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[720px] p-0">
        <div className="border-b border-border px-5 py-3">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            The review loop is designed to run without the mouse — every hot-path action is one key.
          </DialogDescription>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-5 px-5 py-4">
          {SHORTCUTS.map((s) => (
            <div key={s.group}>
              <div className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                {s.group}
              </div>
              <ul className="flex flex-col gap-1">
                {s.items.map(([keys, desc]) => (
                  <li key={keys} className="flex items-center justify-between gap-3">
                    <span className="text-[12px]">{desc}</span>
                    <span className="flex shrink-0 gap-1">
                      {keys.split(' ').map((k, i) =>
                        k === '/' || k === '–' ? (
                          <span key={i} className="text-[11px] text-muted-foreground">
                            {k}
                          </span>
                        ) : (
                          <kbd key={i} className="kbd">
                            {k}
                          </kbd>
                        ),
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
