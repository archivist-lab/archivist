import type { ReactNode, SVGProps } from 'react'

export type PlayerIconName = 'play' | 'restart' | 'trailer' | 'watched' | 'info' | 'refresh' | 'media' | 'chevron-right' | 'check' | 'star' | 'close'

const paths: Record<PlayerIconName, ReactNode> = {
  play: <path d="m9 7 8 5-8 5V7Z" />,
  restart: <><path d="M4.5 9A8 8 0 1 1 5 16" /><path d="M4.5 4.5V9H9" /></>,
  trailer: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3V9ZM7 5V3m10 2V3" /></>,
  watched: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 1-2-5" /></>,
  media: <><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="1.5" fill="currentColor" /><circle cx="15" cy="12" r="1.5" fill="currentColor" /><circle cx="11" cy="17" r="1.5" fill="currentColor" /></>,
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  check: <path d="m5 12 4 4L19 6" />,
  star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
}

export function PlayerIcon({ name, size = 20, ...props }: { name: PlayerIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>{paths[name]}</svg>
}
