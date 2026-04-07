import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Tallei — Cross-AI Ghost Memory',
  description: 'The persistent memory layer that bridges Claude and ChatGPT',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        {/* Global Ambient Backgrounds */}
        <div className="bg-gradient-radial"></div>
        <div className="bg-mesh"></div>

        {/* Global Navigation Hub */}
        <nav className="navbar">
          <div className="container nav-container">
            <a href="/" className="logo">
              <div className="logo-icon"></div>
              Tallei
            </a>
            <div className="nav-links">
              <a href="/dashboard" className="btn-ghost">Dashboard</a>
              <a href="/dashboard/keys" className="btn-ghost">API Keys</a>
              <a href="/login" className="btn btn-secondary" style={{ padding: '0.5rem 1.25rem', fontSize: '0.9rem' }}>Log In</a>
            </div>
          </div>
        </nav>

        {children}
      </body>
    </html>
  )
}
