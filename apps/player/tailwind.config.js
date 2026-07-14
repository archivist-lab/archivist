/** Locked Archivist design language — identical tokens to the server app. */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
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
        display: ['Bebas Neue', 'sans-serif'],
        mono:    ['JetBrains Mono', 'monospace'],
        sans:    ['DM Sans', 'sans-serif'],
      },
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
