import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

// Only the topmost modal handles keys and focus. Lower panels are inert.
const modalStack: HTMLElement[] = [];
let previousBodyOverflow = "";
export function useModalFocus(panelRef: RefObject<HTMLDivElement>, open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const panel = panelRef.current;
    const restore = document.activeElement;
    if (!modalStack.length) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    modalStack.push(panel);
    const sync = () => modalStack.forEach((entry, index) => {
      const hidden = index !== modalStack.length - 1;
      entry.inert = hidden;
      if (hidden) entry.setAttribute("aria-hidden", "true"); else entry.removeAttribute("aria-hidden");
    });
    sync();
    if (!panel.contains(document.activeElement)) panel.focus();
    const top = () => modalStack[modalStack.length - 1] === panel;
    const onFocus = (event: FocusEvent) => {
      if (top() && !panel.contains(event.target as Node)) panel.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!top()) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); return;
      }
      if (event.key !== "Tab") return;
      const elements = Array.from(panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]'))
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && element.getClientRects().length > 0);
      const first = elements[0]; const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); panel.focus(); return; }
      if (document.activeElement === panel || !panel.contains(document.activeElement)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus, true);
      const index = modalStack.indexOf(panel);
      if (index >= 0) modalStack.splice(index, 1);
      panel.inert = false; panel.removeAttribute("aria-hidden"); sync();
      if (!modalStack.length) document.body.style.overflow = previousBodyOverflow;
      if (restore instanceof HTMLElement && restore.isConnected && !restore.closest('[inert]')) restore.focus();
      else modalStack[modalStack.length - 1]?.focus();
    };
  }, [open, panelRef]);
}

/**
 * Accessible modal dialog. Provides an overlay, focus trap, Esc-to-close,
 * focus restore on close, and ARIA wiring. `role`/`closeOnOverlay` are
 * configurable so it can serve as both a dialog and an alert dialog.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  role = "dialog",
  closeOnOverlay = false,
  showCloseButton = true,
  size = "md",
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  role?: "dialog" | "alertdialog";
  closeOnOverlay?: boolean;
  showCloseButton?: boolean;
  /** Panel width: "md" (default, ~28rem) for a form/confirm; "xl" (~48rem) for a wide list/table. */
  size?: "md" | "xl";
  footer?: React.ReactNode;
}) {
  const sizeClass = size === "xl" ? "max-w-3xl" : "max-w-md";
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useRef<string>(`dialog-${Math.random().toString(36).slice(2)}`);
  useModalFocus(panelRef, open, onClose);

  if (!open) return null;

  // Portaled to document.body: a dialog rendered from inside a virtualized
  // message row (e.g. a skill-token click deep in the chat transcript) would
  // otherwise inherit that row's CSS `transform` as its containing block —
  // transforms create a new containing block for `position: fixed`
  // descendants — clipping/misplacing the overlay instead of covering the
  // real viewport.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4">
      <div
        className="fixed inset-0 bg-overlay/60"
        onClick={closeOnOverlay ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId.current}
        tabIndex={-1}
        className={`relative z-10 flex max-h-[calc(100dvh-1rem)] w-full ${sizeClass} flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-lift outline-none sm:max-h-[calc(100dvh-2rem)]`}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <h2 id={titleId.current} className="text-base font-medium">
            {title}
          </h2>
          {showCloseButton && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex min-h-11 min-w-11 items-center justify-center rounded-full border border-border bg-canvas p-1.5 text-fg-dim hover:bg-bg-hover hover:text-fg"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
        {footer && <div className="shrink-0 border-t border-border px-4 py-3 sm:px-5">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/** Confirmation dialog. `tone="destructive"` (default) is red, for irreversible actions like delete; `tone="default"` uses the accent color for a plain yes/no confirmation. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Delete",
  tone = "destructive",
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  tone?: "destructive" | "default";
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} role="alertdialog" closeOnOverlay>
      <div>
        <div className="text-sm leading-6 text-fg-dim">{message}</div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 font-mono text-sm uppercase tracking-[0.06em] text-fg-dim hover:bg-bg-hover hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`rounded-md px-3.5 py-1.5 font-mono text-sm font-medium uppercase tracking-[0.06em] transition-colors ${
              tone === "destructive"
                ? "bg-error text-on-error hover:opacity-90"
                : "bg-accent text-on-accent hover:bg-accent-hover"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Dialog with a single text input and inline validation. */
export function InputDialog({
  open,
  onClose,
  onConfirm,
  title,
  label,
  initialValue = "",
  placeholder,
  validate,
  confirmLabel = "Save",
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (value: string) => void;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  /** Returns an error message for the current value, or null/"" when valid. */
  validate?: (value: string) => string | null;
  confirmLabel?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const error = validate ? validate(value) : null;

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const submit = () => {
    if (error) return;
    onConfirm(value);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      closeOnOverlay={false}
      showCloseButton={false}
    >
      <div>
        <label className="mb-1 block text-xs font-medium text-fg-dim">{label}</label>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
          placeholder={placeholder}
          className="w-full rounded-lg border border-border bg-canvas px-3 py-2 font-mono text-sm outline-none placeholder:text-fg-faint focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        {error && <p className="mt-1.5 text-xs text-error">{error}</p>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 font-mono text-sm uppercase tracking-[0.06em] text-fg-dim hover:bg-bg-hover hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!!error || !value.trim()}
            className="rounded-md bg-accent px-3.5 py-1.5 font-mono text-sm font-medium uppercase tracking-[0.06em] text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
