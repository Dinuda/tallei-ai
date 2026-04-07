import Link from 'next/link';

export default function Home() {
  return (
    <main className="main-content">
      <div className="container">
        
        {/* Hero Section */}
        <div style={{ textAlign: 'center', marginTop: '4rem', marginBottom: '6rem' }}>
          <div className="badge badge-primary animate-fade-in delay-1" style={{ marginBottom: '1.5rem' }}>
            Introducing the Cross-AI Ghost Memory
          </div>
          
          <h1 className="animate-fade-in delay-2" style={{ marginBottom: '1.5rem' }}>
            Never start from zero.<br/>
            <span className="text-gradient-accent">Your AI now remembers you.</span>
          </h1>
          
          <p className="subtitle animate-fade-in delay-3" style={{ margin: '0 auto 3rem auto' }}>
            Tallei seamlessly bridges context between Claude, ChatGPT, and Gemini. Stop re-explaining who you are, what you're working on, and how you like things done. 
          </p>
          
          <div className="animate-fade-in delay-3" style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
            <Link href="/register" className="btn btn-primary">
              Get Started Free
            </Link>
            <Link href="/dashboard/setup" className="btn btn-secondary">
              View Documentation
            </Link>
          </div>
        </div>

        {/* Feature Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '2rem' }} className="animate-fade-in delay-3">
          
          <div className="glass-panel">
            <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>🧠</div>
            <h3 style={{ marginBottom: '0.75rem' }}>Automatic Synchronization</h3>
            <p style={{ color: 'var(--text-secondary)' }}>
              Memories are quietly parsed and stored at the end of your interactions via our high-speed vector pipeline.
            </p>
          </div>

          <div className="glass-panel">
            <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>⚡️</div>
            <h3 style={{ marginBottom: '0.75rem' }}>Inject Context Instantly</h3>
            <p style={{ color: 'var(--text-secondary)' }}>
              Start a new chat, call the Tallei MCP endpoint, and load relevant context right into your system prompt.
            </p>
          </div>

          <div className="glass-panel">
            <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>🔒</div>
            <h3 style={{ marginBottom: '0.75rem' }}>Private & Secure</h3>
            <p style={{ color: 'var(--text-secondary)' }}>
              Each user generates hashed API tokens ensuring complete privacy across every platform integration.
            </p>
          </div>

        </div>

      </div>
    </main>
  )
}
