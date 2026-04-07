'use client';

import { useEffect, useState } from 'react';

interface MemoryItem {
  id: string;
  text: string;
  metadata: Record<string, string>;
  createdAt: string;
}

export default function DashboardPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMemories = async () => {
      try {
        const token = localStorage.getItem('tallei_token');
        const res = await fetch('http://localhost:3000/api/memories', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setMemories(data.memories || []);
        }
      } catch (err) {
        console.error("Failed to fetch memories:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchMemories();
  }, []);

  return (
    <div className="glass-panel">
      <h2 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Memory Feed
        <span className="badge badge-primary">{memories.length}</span>
      </h2>
      
      {loading ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading your timeline...</div>
      ) : memories.length === 0 ? (
        <div style={{ padding: '4rem 2rem', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px dashed var(--border-color)' }}>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>No memories have been captured yet.</p>
          <p style={{ fontSize: '0.9rem' }}>Use Claude Desktop or our API to save your first context block.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {memories.map((m) => (
            <div key={m.id} style={{ 
              padding: '1.5rem', 
              background: 'rgba(255,255,255,0.03)', 
              borderRadius: '12px', 
              border: '1px solid var(--border-color)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem', alignItems: 'center' }}>
                <span className="badge" style={{ background: '#374151', color: '#d1d5db' }}>
                  {m.metadata?.platform || 'API'}
                </span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  {m.createdAt ? new Date(m.createdAt).toLocaleDateString() : 'Unknown date'}
                </span>
              </div>
              <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text-primary)', fontSize: '0.95rem' }}>{m.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
