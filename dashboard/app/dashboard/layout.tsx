'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
    const token = localStorage.getItem('tallei_token');
    if (!token) {
      router.push('/login');
    }
  }, [router]);

  if (!isClient) return null; // Prevent hydration flash

  const handleLogout = () => {
    localStorage.removeItem('tallei_token');
    router.push('/login');
  };

  const tabs = [
    { name: 'Memories', path: '/dashboard' },
    { name: 'API Keys', path: '/dashboard/keys' },
    { name: 'Setup', path: '/dashboard/setup' }
  ];

  return (
    <div className="container" style={{ display: 'flex', gap: '3rem', paddingTop: '8rem', paddingBottom: '4rem', minHeight: '100vh', alignItems: 'flex-start' }}>
      
      {/* Sidebar */}
      <aside style={{ width: '240px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '1.5rem', position: 'sticky', top: '8rem' }}>
        <div style={{ padding: '0 1rem' }}>
          <h3 style={{ fontSize: '1rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '1rem' }}>Menu</h3>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {tabs.map(tab => (
              <Link 
                key={tab.path} 
                href={tab.path}
                style={{
                  padding: '0.75rem 1rem',
                  borderRadius: '10px',
                  color: pathname === tab.path ? 'var(--accent-secondary)' : 'var(--text-primary)',
                  background: pathname === tab.path ? 'rgba(14, 165, 233, 0.1)' : 'transparent',
                  fontWeight: pathname === tab.path ? '600' : '400',
                  transition: 'all var(--transition-fast)'
                }}
              >
                {tab.name}
              </Link>
            ))}
          </nav>
        </div>
        
        <div style={{ marginTop: 'auto', padding: '1rem', borderTop: '1px solid var(--border-color)' }}>
          <button onClick={handleLogout} className="btn-ghost" style={{ width: '100%', textAlign: 'left', color: '#ef4444' }}>
            Log Out
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main style={{ flex: 1, minWidth: 0 }} className="animate-fade-in">
        {children}
      </main>

    </div>
  );
}
