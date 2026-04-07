/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0a',
        surface: '#111111',
        'surface-raised': '#161616',
        'surface-hover': '#1a1a1a',
        border: '#1e1e1e',
        'border-hover': '#2a2a2a',
        text: '#e5e7eb',
        'text-dim': '#9ca3af',
        'text-muted': '#6b7280',
        accent: '#3b82f6',
        'accent-dim': '#3b82f620',
        success: '#22c55e',
        'success-dim': '#22c55e20',
        error: '#ef4444',
        'error-dim': '#ef444420',
        warning: '#f59e0b',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '8px',
        sm: '6px',
        lg: '12px',
        xl: '16px',
      },
    },
  },
  plugins: [],
};
