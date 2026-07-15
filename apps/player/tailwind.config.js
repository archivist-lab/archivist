/** Locked Archivist design language — identical tokens to the server app. */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        player: {
          bg: 'var(--player-bg)',
          panel: 'var(--player-panel)',
          text: 'var(--player-text)',
          muted: 'var(--player-muted)',
          accent: 'var(--player-accent)',
          danger: 'var(--player-danger)',
        },
        noir: {
          950: '#0a0a0f',
          900: '#111118',
          800: '#1a1a24',
          700: '#242430',
        },
        cyan:   '#00D4FF',
        violet: '#9B59B6',
        pink:   '#FF2D78',
      },
      fontFamily: {
        display: ['system-ui', 'sans-serif'],
        mono:    ['ui-monospace', 'SFMono-Regular', 'monospace'],
        sans:    ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
      spacing: { 'safe-x': 'var(--safe-x)', 'safe-y': 'var(--safe-y)' },
      transitionDuration: { 80: '80ms', 140: '140ms', 180: '180ms', 280: '280ms' },
      keyframes: {
        'fade-in':  { from: { opacity: '0' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(16px)' } },
      },
      animation: {
        'fade-in':  'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.25s ease-out',
      },
    },
  },
  plugins: [],
}
