/**
 * Toast host (Task 9): renders the store's toast queue in a daisyUI
 * `toast toast-end` stack. Toasts auto-dismiss after 5s (store-side);
 * each also has a manual dismiss button.
 */
import type { JSX } from 'react'
import { useAppStore } from '../store'
import type { ToastKind } from '../store'

const ALERT_CLASS: Record<ToastKind, string> = {
  info: 'alert-info',
  success: 'alert-success',
  error: 'alert-error'
}

export default function ToastHost(): JSX.Element | null {
  const toasts = useAppStore((s) => s.toasts)
  const dismissToast = useAppStore((s) => s.dismissToast)

  if (toasts.length === 0) return null

  return (
    <div className="toast toast-end z-50 mb-16 lg:mb-0">
      {toasts.map((t) => (
        <div key={t.id} role="alert" className={`alert ${ALERT_CLASS[t.kind]}`}>
          <span className="max-w-xs whitespace-normal break-words">
            {t.text}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            aria-label="Dismiss notification"
            onClick={() => dismissToast(t.id)}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-4"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
