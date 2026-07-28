import { Pencil, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { ResolvedField } from '../../shared/ipc.js';
import { openExternal } from '../lib/api.js';
import { cn } from '../lib/utils.js';
import { ConflictPicker } from './ConflictPicker.js';
import { ProvenanceBadge } from './ProvenanceBadge.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

export type FieldType = 'text' | 'number' | 'url' | 'email';

export interface FieldProps {
  label: string;
  value: string | null;
  editable?: boolean;
  onSave?: (v: string) => void;
  provenance?: ResolvedField;
  conflicting?: boolean;
  onResolveConflict?: (obsId: number) => void;
  type?: FieldType;
  placeholder?: string;
  /** Rendered instead of the plain value — chips, links, verification badges. */
  render?: ReactNode;
  mono?: boolean;
  className?: string;
}

/**
 * The one data primitive the whole app is built from: a label, a value, its
 * provenance, and a one-keystroke path to editing it.
 *
 * The row is a tab stop rather than the input, so `tab` walks fields at reading
 * speed and `e` opens the one you're on. Committing never destroys the previous
 * value — main writes a new observation with source `human`.
 */
export function Field({
  label,
  value,
  editable,
  onSave,
  provenance,
  conflicting,
  onResolveConflict,
  type = 'text',
  placeholder,
  render,
  mono,
  className,
}: FieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const rowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  const canEdit = !!editable && !!onSave;

  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  // The global `e` hotkey cannot reach into this component's state, so it
  // dispatches an event at the focused row instead.
  const beginEditRef = useRef<() => void>(() => {});
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const onEdit = () => beginEditRef.current();
    el.addEventListener('field:edit', onEdit);
    return () => el.removeEventListener('field:edit', onEdit);
  }, []);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function beginEdit() {
    if (!canEdit) return;
    committedRef.current = false;
    setDraft(value ?? '');
    setEditing(true);
  }
  beginEditRef.current = beginEdit;

  function commit() {
    if (committedRef.current) return;
    committedRef.current = true;
    setEditing(false);
    const next = draft.trim();
    if (next !== (value ?? '').trim()) onSave?.(next);
    rowRef.current?.focus();
  }

  function cancel() {
    committedRef.current = true;
    setEditing(false);
    setDraft(value ?? '');
    rowRef.current?.focus();
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!canEdit || editing) return;
    if (e.key === 'e' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      beginEdit();
    }
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Tab') {
      // Commit and step to the next field — editing several fields in a row is
      // the common case, and a modal-feeling edit would break it.
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      commit();
      requestAnimationFrame(() => moveFieldFocus(dir));
    }
  }

  return (
    <div
      ref={rowRef}
      data-field-row
      data-field-label={label}
      tabIndex={editing ? -1 : 0}
      onKeyDown={onRowKeyDown}
      onDoubleClick={beginEdit}
      className={cn(
        'group/field grid min-h-6 grid-cols-[104px_minmax(0,1fr)_auto] items-center gap-2 rounded px-1 py-0.5 outline-none',
        'focus-visible:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring',
        conflicting && 'bg-warn/8',
        className,
      )}
    >
      <span className="truncate text-[11px] text-muted-foreground">{label}</span>

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          inputMode={type === 'number' ? 'numeric' : undefined}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onInputKeyDown}
          onBlur={commit}
          className="h-6 w-full rounded border border-ring bg-background px-1.5 font-mono text-[12px] outline-none"
        />
      ) : (
        <span
          className={cn(
            'min-w-0 truncate text-[12px]',
            mono && 'font-mono',
            value == null || value === '' ? 'text-muted-foreground/60' : undefined,
          )}
          data-selectable
          title={value ?? undefined}
        >
          {render ??
            (value == null || value === '' ? (
              <span className="italic">{placeholder ?? '—'}</span>
            ) : type === 'url' ? (
              <button
                type="button"
                className="truncate text-primary hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  openExternal(normalizeUrl(value));
                }}
              >
                {value}
              </button>
            ) : (
              value
            ))}
        </span>
      )}

      <span className="flex shrink-0 items-center gap-0.5">
        {canEdit && !editing && (
          <button
            type="button"
            aria-label={`Edit ${label}`}
            onClick={beginEdit}
            className="flex size-4 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity outline-none group-hover/field:opacity-70 hover:bg-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pencil className="size-2.5" />
          </button>
        )}

        {conflicting && provenance && onResolveConflict && (
          <Popover>
            <PopoverTrigger
              aria-label={`Resolve conflicting values for ${label}`}
              className="flex size-4 items-center justify-center rounded text-warn outline-none hover:bg-warn/15 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <TriangleAlert className="size-3" />
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0" align="end">
              <ConflictPicker provenance={provenance} onPick={onResolveConflict} />
            </PopoverContent>
          </Popover>
        )}

        {provenance && <ProvenanceBadge provenance={provenance} />}
      </span>
    </div>
  );
}

function normalizeUrl(v: string): string {
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/**
 * Walks the tab stops that Fields expose. Kept here rather than in the screen so
 * `tab` inside an open editor and the global `tab` hotkey share one traversal.
 */
export function moveFieldFocus(dir: 1 | -1, root?: HTMLElement | null): void {
  const scope = root ?? document.querySelector<HTMLElement>('[data-detail-pane]');
  if (!scope) return;
  const rows = Array.from(scope.querySelectorAll<HTMLElement>('[data-field-row]'));
  if (rows.length === 0) return;

  const active = document.activeElement as HTMLElement | null;
  const current = rows.findIndex((r) => r === active || r.contains(active));
  const next =
    current < 0 ? (dir === 1 ? 0 : rows.length - 1) : (current + dir + rows.length) % rows.length;

  rows[next]?.focus();
  rows[next]?.scrollIntoView({ block: 'nearest' });
}

/** Opens the editor on whichever Field currently holds focus. */
export function editFocusedField(): boolean {
  const active = document.activeElement as HTMLElement | null;
  const row = active?.closest<HTMLElement>('[data-field-row]');
  if (!row) return false;
  row.dispatchEvent(new CustomEvent('field:edit'));
  return true;
}
