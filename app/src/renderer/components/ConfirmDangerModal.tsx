/**
 * Generic destructive-action confirmation modal (Task 11).
 *
 * Open-controlled daisyUI modal (modal-top) that stacks ABOVE the
 * ExportModal (z-[1000] beats daisyUI's .modal z-index of 999). Renders
 * an alert-warning / alert-error banner with the caller-supplied body,
 * and — when `requireTypedWord` is set — an input the user must match
 * exactly (e.g. DELETE) before the Confirm button enables.
 *
 * Prop contract is BINDING: destructive-action flows (include-auth
 * warning, purge-source DELETE confirmation, clear-all-settings) build
 * against ConfirmDangerModalProps exactly as declared here.
 */
import { useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'

export interface ConfirmDangerModalProps {
  open: boolean
  variant: 'warning' | 'error'
  title: string
  body: ReactNode
  confirmLabel: string
  /** When set, the user must type this word to enable Confirm (e.g. DELETE). */
  requireTypedWord?: string
  onConfirm: () => void
  onCancel: () => void
}

/** Lucide-style triangle-alert (warning) / octagon-alert (error) glyph. */
function DangerIcon({ variant }: { variant: 'warning' | 'error' }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-6 shrink-0"
      aria-hidden="true"
    >
      {variant === 'warning' ? (
        <>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </>
      ) : (
        <>
          <path d="M12 16h.01" />
          <path d="M12 8v4" />
          <path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z" />
        </>
      )}
    </svg>
  )
}

export default function ConfirmDangerModal(
  props: ConfirmDangerModalProps
): JSX.Element {
  const {
    open,
    variant,
    title,
    body,
    confirmLabel,
    requireTypedWord,
    onConfirm,
    onCancel
  } = props

  const [typed, setTyped] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset the typed word on every open; focus the input when one is shown.
  useEffect(() => {
    if (!open) return
    setTyped('')
    inputRef.current?.focus()
  }, [open])

  // Escape = Cancel (reverts the guarded toggle in the caller). The
  // ExportModal's own Escape handler stays inactive while this is open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  const confirmReady =
    requireTypedWord === undefined || typed === requireTypedWord

  return (
    <div
      className={`modal modal-top z-[1000] ${open ? 'modal-open' : ''}`}
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="modal-box mx-auto w-full max-w-xl">
        <h3 className="text-lg font-bold">{title}</h3>

        <div
          role="alert"
          className={`alert mt-3 items-start text-left ${
            variant === 'warning' ? 'alert-warning' : 'alert-error'
          }`}
        >
          <DangerIcon variant={variant} />
          <div className="min-w-0 text-sm">{body}</div>
        </div>

        {requireTypedWord !== undefined && (
          <fieldset className="fieldset mt-2">
            <legend className="fieldset-legend">
              Type <span className="font-mono">{requireTypedWord}</span> to
              confirm
            </legend>
            <input
              ref={inputRef}
              type="text"
              className="input w-full font-mono"
              value={typed}
              placeholder={requireTypedWord}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && confirmReady) onConfirm()
              }}
            />
          </fieldset>
        )}

        <div className="modal-action">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${
              variant === 'warning' ? 'btn-warning' : 'btn-error'
            }`}
            disabled={!confirmReady}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>

      <div className="modal-backdrop">
        <button type="button" tabIndex={-1} onClick={onCancel}>
          close
        </button>
      </div>
    </div>
  )
}
