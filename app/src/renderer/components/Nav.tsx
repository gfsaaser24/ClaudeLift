/**
 * App navigation (Task 9): left rail (daisyUI menu, w-56) on lg and up,
 * bottom bar (daisyUI dock) below lg. Icons are hand-written inline
 * SVG paths (lucide-style, stroke = currentColor).
 */
import type { JSX, ReactNode } from 'react'
import { useAppStore } from '../store'
import type { ViewName } from '../store'

function LogoMark(): JSX.Element {
  return (
    <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="8.5" fill="var(--color-primary)" />
      <g
        fill="none"
        stroke="#fff"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10.5 23h11" />
        <path d="M16 20V10" />
        <path d="M11.5 14.5 16 10l4.5 4.5" />
      </g>
    </svg>
  )
}

function Wordmark(): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-4 pt-4 pb-3">
      <LogoMark />
      <span className="font-serif text-2xl leading-none">
        <span className="text-base-content">Claude</span>
        <span className="text-primary">Lift</span>
      </span>
    </div>
  )
}

function NavIcon({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

interface NavItem {
  view: ViewName
  label: string
  icon: JSX.Element
}

const NAV_ITEMS: NavItem[] = [
  {
    view: 'tasks',
    label: 'Tasks',
    icon: (
      <NavIcon>
        <path d="M8 6h13" />
        <path d="M8 12h13" />
        <path d="M8 18h13" />
        <path d="M3 6h.01" />
        <path d="M3 12h.01" />
        <path d="M3 18h.01" />
      </NavIcon>
    )
  },
  {
    view: 'bundles',
    label: 'Bundles',
    icon: (
      <NavIcon>
        <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
        <path d="m3.3 7 8.7 5 8.7-5" />
        <path d="M12 22V12" />
      </NavIcon>
    )
  },
  {
    view: 'notion',
    label: 'Notion',
    icon: (
      <NavIcon>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 17V7l6 10V7" />
      </NavIcon>
    )
  },
  {
    view: 'settings',
    label: 'Settings',
    icon: (
      <NavIcon>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </NavIcon>
    )
  }
]

export default function Nav(): JSX.Element {
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)

  return (
    <>
      {/* lg and up: fixed-width left rail */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-base-300 bg-base-100 lg:flex">
        <Wordmark />
        <ul className="menu w-full grow px-2">
          {NAV_ITEMS.map((item) => (
            <li key={item.view}>
              <button
                type="button"
                className={view === item.view ? 'menu-active' : undefined}
                onClick={() => setView(item.view)}
              >
                {item.icon}
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* below lg: bottom dock */}
      <div className="dock z-40 lg:hidden">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            type="button"
            className={view === item.view ? 'dock-active' : undefined}
            onClick={() => setView(item.view)}
          >
            {item.icon}
            <span className="dock-label">{item.label}</span>
          </button>
        ))}
      </div>
    </>
  )
}
