import { useEffect, useRef, useState, type JSX } from 'react'
import { Button, Card, Chip, Separator } from '@heroui/react'
import { Navbar, CodeBlock } from '@heroui-pro/react'
import {
  ArrowDownToLine,
  TerminalLine,
  Layers3Diagonal,
  LayoutCellsLarge,
  PaperPlane,
  ArrowsRotateLeft,
  PlayFill,
  StarFill
} from '@gravity-ui/icons'

const REPO = 'gfsaaser24/ClaudeLift'
const REPO_URL = `https://github.com/${REPO}`
const DOWNLOAD_URL = `${REPO_URL}/releases/latest`
const VIDEO_URL = 'https://jarvis-client-uploads.b-cdn.net/claudelift/claudeliftlaunch.mp4'

const BUNDLE_FILES = [
  'session.html',
  'session.md',
  'session.json',
  'session.csv',
  'uploads/',
  'outputs/',
  'files/',
  'manifest.json',
  'seed-prompt.md'
]

const MCP_TOOLS = [
  'claudelift_list_tasks',
  'claudelift_export_task',
  'claudelift_get_transcript',
  'claudelift_seed_prompt',
  'claudelift_list_bundles',
  'claudelift_import_bundle'
]

const TERMINAL_CODE = `> pull the transcript of my SOP chat

⏺ claudelift_get_transcript("SOP")
  └ Detailing SOP builder · 42 messages · 7 files

Loaded. Continuing where you left off…`

const FEATURES: { title: string; body: string; icon: JSX.Element }[] = [
  {
    title: 'One-Click Export',
    body: 'The full transcript rendered to HTML, Markdown, JSON, or CSV — plus every upload and every file Claude generated.',
    icon: <ArrowDownToLine />
  },
  {
    title: 'Resume Anywhere',
    body: 'A local MCP server ships with the app. Claude Code, Cursor, or Claude Desktop pulls any chat straight from the prompt.',
    icon: <TerminalLine />
  },
  {
    title: 'Batch Export',
    body: 'Archive every chat on your machine in one run. Ninety chats or nine hundred.',
    icon: <Layers3Diagonal />
  },
  {
    title: 'Bundle Browser',
    body: "Card and list views of everything you've exported, with in-app transcript preview.",
    icon: <LayoutCellsLarge />
  },
  {
    title: 'Publish to Notion',
    body: 'Send a finished chat to your workspace as a real page, not a paste.',
    icon: <PaperPlane />
  },
  {
    title: 'Migrate & Re-Import',
    body: 'Move a bundle to another machine — or another account — and pick up where it left off.',
    icon: <ArrowsRotateLeft />
  }
]

function Wordmark({ className = 'text-2xl' }: { className?: string }) {
  return (
    <span className={`font-serif leading-none tracking-tight ${className}`}>
      Claude<span className="text-accent">Lift</span>
    </span>
  )
}

function GitHubIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

function XIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  )
}

function LinkedInIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.72v20.55C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.72C24 .77 23.2 0 22.22 0Z" />
    </svg>
  )
}

function useGitHubStars() {
  const [stars, setStars] = useState<number | null>(null)
  useEffect(() => {
    const cached = sessionStorage.getItem('cl-stars')
    if (cached) {
      const { v, t } = JSON.parse(cached)
      if (Date.now() - t < 3_600_000) {
        setStars(v)
        return
      }
    }
    fetch(`https://api.github.com/repos/${REPO}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setStars(d.stargazers_count)
        sessionStorage.setItem('cl-stars', JSON.stringify({ v: d.stargazers_count, t: Date.now() }))
      })
      .catch(() => {})
  }, [])
  return stars
}

function formatStars(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n)
}

/* Anchors styled with theme tokens — real links for navigation CTAs */
function AccentLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 rounded-xl bg-accent px-6 py-2.5 text-accent-foreground shadow-surface transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {children}
    </a>
  )
}

function SurfaceLink({
  href,
  external,
  children
}: {
  href: string
  external?: boolean
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-6 py-2.5 text-surface-foreground shadow-surface transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {children}
    </a>
  )
}

function VideoWindow() {
  const [playing, setPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  const play = () => {
    setPlaying(true)
    requestAnimationFrame(() => videoRef.current?.play())
  }

  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-surface shadow-surface">
      <figcaption className="flex items-center justify-between border-b border-separator px-4 py-2.5">
        <span className="text-sm text-muted">ClaudeLift — 70 Second Demo</span>
        <Chip size="sm">1:10</Chip>
      </figcaption>
      <div className="relative aspect-video bg-black">
        <video
          ref={videoRef}
          className="h-full w-full"
          poster="/poster.jpg"
          preload="metadata"
          controls={playing}
          playsInline
        >
          <source src={VIDEO_URL} type="video/mp4" />
        </video>
        {!playing && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Button size="lg" onPress={play} aria-label="Play the 70 second demo">
              <PlayFill data-slot="icon" />
              Watch the Demo
            </Button>
          </div>
        )}
      </div>
    </figure>
  )
}

export default function App() {
  const stars = useGitHubStars()

  return (
    <>
      <Navbar>
        <Navbar.Header className="mx-auto max-w-6xl">
          <Navbar.Brand>
            <a href="/" aria-label="ClaudeLift home">
              <Wordmark />
            </a>
          </Navbar.Brand>

          <Navbar.Spacer />

          <Navbar.Content className="max-sm:hidden!">
            <Navbar.Item href="#features">Features</Navbar.Item>
            <Navbar.Item href="#mcp">Resume via MCP</Navbar.Item>
            <Navbar.Item href={REPO_URL} target="_blank" rel="noreferrer">
              GitHub{stars !== null ? ` · ${formatStars(stars)}★` : ''}
            </Navbar.Item>
          </Navbar.Content>

          <Navbar.Spacer />

          <Navbar.Content>
            <a
              href={DOWNLOAD_URL}
              className="inline-flex items-center rounded-lg bg-accent px-4 py-1.5 text-sm text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Download
            </a>
          </Navbar.Content>
        </Navbar.Header>
      </Navbar>

      <main>
        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 pt-20 pb-14 text-center sm:pt-28">
          <p className="text-sm text-muted">
            Free <span className="text-accent">·</span> Open source{' '}
            <span className="text-accent">·</span> Windows
          </p>
          <h1 className="mx-auto mt-5 max-w-4xl font-serif text-[clamp(2.75rem,7vw,5.25rem)] leading-[1.05] tracking-tight text-balance">
            Git for your <em className="text-accent">Cowork</em> chats.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted">
            Every Claude Cowork chat runs in a sandbox that dies when you close the app.
            ClaudeLift exports the whole thing — transcript plus every file — into a bundle
            you own, and resumes it anywhere.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <AccentLink href={DOWNLOAD_URL}>Download for Windows</AccentLink>
            <SurfaceLink href={REPO_URL} external>
              <GitHubIcon />
              Star on GitHub
              {stars !== null && (
                <span className="inline-flex items-center gap-1 text-sm text-muted">
                  <StarFill className="size-3.5" aria-hidden="true" />
                  {formatStars(stars)}
                </span>
              )}
            </SurfaceLink>
          </div>
          <p className="mt-6 text-xs tracking-wide text-muted">
            v0.5.0 · MIT license · Windows 10/11
          </p>

          {/* Product Hunt launch card */}
          <div className="mx-auto mt-8 flex w-full max-w-md items-center gap-4 rounded-xl border border-border bg-surface p-4 text-left shadow-surface">
            <img
              src="https://ph-files.imgix.net/bd208029-e701-42a0-b4a3-b5bd3960e820.png?auto=compress,format&codec=mozjpeg&cs=strip&fit=crop&h=80&w=80"
              alt="ClaudeLift on Product Hunt"
              width={48}
              height={48}
              loading="lazy"
              className="size-12 shrink-0 rounded-lg object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">We're live on Product Hunt</p>
              <p className="truncate text-sm text-muted">Time Machine for your Claude chats</p>
            </div>
            <a
              href="https://www.producthunt.com/products/claudelift-git-for-claude-cowork-chats?embed=true&utm_source=embed&utm_medium=post_embed"
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded-lg bg-[#FF6154] px-3.5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Check it out →
            </a>
          </div>

          {/* Uneed launch badge */}
          <div className="mt-4 flex justify-center">
            <a
              href="https://www.uneed.best/tool/claudelift"
              target="_blank"
              rel="noreferrer"
              aria-label="ClaudeLift on Uneed"
              className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <img
                src="https://www.uneed.best/EMBED3.png"
                alt="Uneed Embed Badge"
                loading="lazy"
                className="h-12 w-auto"
              />
            </a>
          </div>
        </section>

        {/* ── Demo ──────────────────────────────────────────────────────── */}
        <section className="mx-auto max-w-4xl px-6" aria-label="Product demo">
          <VideoWindow />
        </section>

        {/* ── Bundle contents ───────────────────────────────────────────── */}
        <section className="mx-auto max-w-4xl px-6 pt-14">
          <div className="rounded-xl bg-surface-secondary px-6 py-6 text-center sm:px-10">
            <h2 className="font-serif text-2xl">Inside Every Bundle</h2>
            <ul className="mt-4 flex flex-wrap items-center justify-center gap-2" role="list">
              {BUNDLE_FILES.map((f) => (
                <li key={f}>
                  <Chip size="sm" variant="secondary" className="bg-surface font-mono">
                    {f}
                  </Chip>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Features ──────────────────────────────────────────────────── */}
        <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
          <h2 className="font-serif text-4xl tracking-tight sm:text-5xl">
            Everything Leaves <em className="text-accent">With You</em>.
          </h2>
          <p className="mt-3 max-w-2xl text-lg text-muted">
            Not a screenshot. Not a copy-paste. The chat itself, in formats you can actually use.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <Card key={f.title}>
                <span className="text-muted [&_svg]:size-5" aria-hidden="true">
                  {f.icon}
                </span>
                <Card.Header>
                  <Card.Title>{f.title}</Card.Title>
                  <Card.Description>{f.body}</Card.Description>
                </Card.Header>
              </Card>
            ))}
          </div>
        </section>

        {/* ── MCP resume ────────────────────────────────────────────────── */}
        <section id="mcp" className="scroll-mt-20 border-y border-separator bg-surface">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2">
            <div>
              <p className="text-sm text-muted">The part we're most excited about</p>
              <h2 className="mt-3 font-serif text-4xl tracking-tight sm:text-5xl">
                Type a Sentence. Get Your <em className="text-accent">Chat Back</em>.
              </h2>
              <p className="mt-5 text-lg text-muted">
                ClaudeLift ships a local MCP server with six tools. Install the one-click
                .mcpb extension for Claude Desktop, or add it to Claude Code and Cursor with
                a single command — then pull any exported chat straight from the prompt.
              </p>
              <ul className="mt-6 flex flex-wrap gap-2" role="list">
                {MCP_TOOLS.map((t) => (
                  <li key={t}>
                    <Chip size="sm" className="font-mono">
                      {t}
                    </Chip>
                  </li>
                ))}
              </ul>
            </div>
            <CodeBlock>
              <CodeBlock.Header>
                <span className="text-xs tracking-wide text-muted">claude code</span>
                <CodeBlock.CopyButton code={TERMINAL_CODE} />
              </CodeBlock.Header>
              <div className="dark overflow-x-auto bg-surface p-5">
                <pre className="font-mono text-sm leading-relaxed text-foreground">
                  <span className="text-muted">&gt;</span> pull the transcript of my SOP chat
                  {'\n\n'}
                  <span className="text-accent-soft-foreground">
                    ⏺ claudelift_get_transcript("SOP")
                  </span>
                  {'\n'}
                  {'  └ '}Detailing SOP builder · 42 messages · 7 files{'\n\n'}
                  <span className="text-muted">Loaded. Continuing where you left off…</span>
                </pre>
              </div>
            </CodeBlock>
          </div>
        </section>

        {/* ── Final CTA ─────────────────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 py-24 text-center">
          <h2 className="font-serif text-5xl tracking-tight text-balance sm:text-6xl">
            Stop Losing Your <em className="text-accent">Best Work</em>.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-muted">
            It's free, and it's yours — like the chats.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <AccentLink href={DOWNLOAD_URL}>Download for Windows</AccentLink>
            <SurfaceLink href={REPO_URL} external>
              <GitHubIcon />
              View Source
            </SurfaceLink>
          </div>
        </section>
      </main>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer>
        <Separator />
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
          <p className="flex items-center gap-2.5 text-sm text-muted">
            <Wordmark className="text-lg" />
            <span aria-hidden="true">·</span> © 2026 · MIT license · Built by Gabe Fletcher
          </p>
          <ul className="flex items-center gap-1" role="list">
            {[
              { href: 'https://x.com/gabefletcher', label: 'Gabe Fletcher on X', icon: <XIcon /> },
              {
                href: 'https://www.linkedin.com/in/gabe-fletcher',
                label: 'Gabe Fletcher on LinkedIn',
                icon: <LinkedInIcon />
              },
              { href: REPO_URL, label: 'ClaudeLift on GitHub', icon: <GitHubIcon /> }
            ].map((s) => (
              <li key={s.href}>
                <a
                  href={s.href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={s.label}
                  className="flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {s.icon}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </footer>
    </>
  )
}
