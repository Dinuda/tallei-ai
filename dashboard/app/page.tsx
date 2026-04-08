'use client';

import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ minHeight: '100vh', overflow: 'hidden' }}>

      {/* Decorative background */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{
          position: 'absolute',
          top: '8%', right: '-8%',
          width: '560px', height: '560px', borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(126,183,27,.18) 0%, transparent 70%)',
        }}/>
        <div style={{
          position: 'absolute',
          bottom: '15%', left: '-6%',
          width: '420px', height: '420px', borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(126,183,27,.12) 0%, transparent 70%)',
        }}/>
        <div style={{
          position: 'absolute',
          top: '45%', left: '40%',
          width: '300px', height: '300px', borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(200,230,80,.08) 0%, transparent 70%)',
        }}/>
      </div>

      <div style={{ position: 'relative', zIndex: 1 }}>
        <div className="container">

          {/* ── Hero ── */}
          <div style={{ paddingTop: 'calc(var(--nav-h) + 5rem)', paddingBottom: '6rem', maxWidth: '720px' }}>

            <div className="badge badge-accent animate-fade-up" style={{ marginBottom: '1.5rem' }}>
              Cross-AI Ghost Memory
            </div>

            <h1 className="animate-fade-up delay-1" style={{ marginBottom: '1.25rem', lineHeight: 1.08 }}>
              Your AI finally<br/>
              <span style={{ color: 'var(--accent)' }}>remembers you.</span>
            </h1>

            <p className="animate-fade-up delay-2" style={{
              fontSize: '1.1rem',
              color: 'var(--text-2)',
              maxWidth: '540px',
              lineHeight: 1.7,
              marginBottom: '2.5rem',
            }}>
              Tallei is the persistent memory layer that bridges Claude, ChatGPT, and Gemini.
              Stop re-explaining who you are — your context travels with you.
            </p>

            <div className="animate-fade-up delay-3" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <Link href="/login" className="btn btn-primary btn-lg">
                Get started free
              </Link>
              <Link href="/dashboard/setup" className="btn btn-secondary btn-lg">
                View setup guide
              </Link>
            </div>

            {/* Social proof pill */}
            <div className="animate-fade-up delay-4" style={{
              marginTop: '2.5rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.6rem',
              padding: '0.5rem 1rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-pill)',
              fontSize: '0.82rem',
              color: 'var(--text-2)',
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: 'var(--accent)',
                animation: 'pulse-dot 2s ease infinite',
                flexShrink: 0,
              }}/>
              Works with Claude · ChatGPT · Gemini
            </div>
          </div>

          {/* ── Feature grid ── */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '1.25rem',
            paddingBottom: '6rem',
          }}>
            {[
              {
                icon: '🔄',
                title: 'Automatic sync',
                desc: 'Memories are quietly parsed and stored at the end of every interaction via our high-speed vector pipeline.',
                delay: 'delay-1',
              },
              {
                icon: '⚡',
                title: 'Instant context injection',
                desc: 'Start a new chat, call the Tallei MCP endpoint, and load relevant context right into your system prompt.',
                delay: 'delay-2',
              },
              {
                icon: '🔒',
                title: 'Private by design',
                desc: 'Each user generates hashed API tokens, ensuring complete privacy across every platform integration.',
                delay: 'delay-3',
              },
            ].map(f => (
              <div
                key={f.title}
                className={`animate-fade-up ${f.delay}`}
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border-light)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '1.75rem',
                  boxShadow: 'var(--shadow-sm)',
                  transition: 'box-shadow 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLDivElement;
                  el.style.boxShadow = 'var(--shadow-md)';
                  el.style.borderColor = 'var(--border)';
                  el.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLDivElement;
                  el.style.boxShadow = 'var(--shadow-sm)';
                  el.style.borderColor = 'var(--border-light)';
                  el.style.transform = 'none';
                }}
              >
                <div style={{ fontSize: '1.75rem', marginBottom: '1rem' }}>{f.icon}</div>
                <h3 style={{ marginBottom: '0.6rem', fontSize: '1rem' }}>{f.title}</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', lineHeight: 1.65, margin: 0 }}>{f.desc}</p>
              </div>
            ))}
          </div>

        </div>
      </div>
    </main>
  );
}
