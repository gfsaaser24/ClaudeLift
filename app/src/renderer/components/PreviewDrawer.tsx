/**
 * PreviewDrawer (Task 12): fixed right-hand side panel rendering the
 * bundle's session.md via react-markdown + remark-gfm.
 *
 * MEMORY RULE (binding): the default export returns null when `bundle` is
 * null — the panel subtree, its fetched markdown text, and the rendered
 * markdown tree fully unmount on close; nothing is cached.
 */
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ReadMarkdownResultSchema,
  type BundleInfo,
  type ReadMarkdownResult
} from '../../shared/ipc'
import { errorText, useAppStore } from '../store'

export interface PreviewDrawerProps {
  /** Bundle to preview, or null when the drawer is closed. */
  bundle: BundleInfo | null
  onClose: () => void
}

export default function PreviewDrawer({ bundle, onClose }: PreviewDrawerProps): JSX.Element | null {
  if (bundle === null) return null
  return <PreviewPanel bundle={bundle} onClose={onClose} />
}

/** Markdown container styling (no typography plugin — utility selectors). */
const MARKDOWN_CLASS =
  'text-sm leading-relaxed break-words ' +
  '[&_h1]:mt-4 [&_h1]:text-2xl [&_h1]:font-bold ' +
  '[&_h2]:mt-4 [&_h2]:text-xl [&_h2]:font-semibold ' +
  '[&_h3]:mt-3 [&_h3]:text-lg [&_h3]:font-semibold ' +
  '[&_h4]:mt-3 [&_h4]:font-semibold ' +
  '[&_p]:mt-2 [&_hr]:my-4 ' +
  '[&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 ' +
  '[&_ol]:mt-2 [&_ol]:list-decimal [&_ol]:pl-5 ' +
  '[&_pre]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded-box [&_pre]:bg-base-200 [&_pre]:p-3 ' +
  '[&_code]:font-mono [&_code]:text-xs ' +
  '[&_blockquote]:mt-2 [&_blockquote]:border-l-4 [&_blockquote]:border-base-300 [&_blockquote]:pl-3 [&_blockquote]:opacity-80 ' +
  '[&_table]:mt-2 [&_table]:block [&_table]:overflow-x-auto ' +
  '[&_th]:border [&_th]:border-base-300 [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold ' +
  '[&_td]:border [&_td]:border-base-300 [&_td]:px-2 [&_td]:py-1 ' +
  '[&_a]:link [&_img]:max-w-full'

function PreviewPanel({ bundle, onClose }: { bundle: BundleInfo; onClose: () => void }): JSX.Element {
  const pushToast = useAppStore((s) => s.pushToast)
  const [result, setResult] = useState<ReadMarkdownResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    setResult(null)
    setError(null)
    window.api
      .bundlesReadMarkdown({ bundleDir: bundle.dir })
      .then((raw) => {
        if (!stale) setResult(ReadMarkdownResultSchema.parse(raw))
      })
      .catch((err: unknown) => {
        if (!stale) setError(errorText(err))
      })
    return () => {
      stale = true
    }
  }, [bundle.dir])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openFolder = (): void => {
    window.api.bundlesOpenFolder({ dir: bundle.dir }).catch((err: unknown) => {
      pushToast('error', `Open folder failed: ${errorText(err)}`)
    })
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close preview"
        className="absolute inset-0 cursor-default bg-neutral/40"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-label={`Preview of ${bundle.title}`}
        className="relative flex h-full w-full max-w-2xl flex-col border-l border-base-300 bg-base-100 shadow-xl"
      >
        <header className="flex items-center gap-2 border-b border-base-300 p-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold" title={bundle.title}>
              {bundle.title}
            </h2>
            <p className="truncate font-mono text-xs opacity-60" title={bundle.dir}>
              {bundle.dir}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-square"
            aria-label="Close preview"
            onClick={onClose}
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
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {result?.truncated === true && (
            <div role="alert" className="alert alert-info mb-4">
              <span>Preview truncated at 2 MB. Open the folder to read the full session.md.</span>
              <button type="button" className="btn btn-sm" onClick={openFolder}>
                Open folder
              </button>
            </div>
          )}

          {error !== null && (
            <div role="alert" className="alert alert-error">
              <span className="whitespace-normal break-words">Could not load session.md: {error}</span>
            </div>
          )}

          {result === null && error === null && (
            <div className="flex justify-center py-10">
              <span className="loading loading-spinner loading-lg" aria-label="Loading preview" />
            </div>
          )}

          {result !== null && (
            <div className={MARKDOWN_CLASS}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.text}</ReactMarkdown>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
