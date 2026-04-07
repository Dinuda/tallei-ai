'use client';

import { useEffect, useState } from 'react';

interface ApiKey {
  id: string;
  name: string;
  lastUsed: string | null;
  createdAt: string;
}

export default function KeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [newlyGeneratedKey, setNewlyGeneratedKey] = useState<string | null>(null);

  const fetchKeys = async () => {
    try {
      const token = localStorage.getItem('tallei_token');
      const res = await fetch('http://localhost:3000/api/keys', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    
    setGenerating(true);
    setNewlyGeneratedKey(null);
    
    try {
      const token = localStorage.getItem('tallei_token');
      const res = await fetch('http://localhost:3000/api/keys', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: newKeyName })
      });
      
      if (res.ok) {
        const data = await res.json();
        setNewlyGeneratedKey(data.key);
        setNewKeyName('');
        await fetchKeys();
      }
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const token = localStorage.getItem('tallei_token');
      const res = await fetch(`http://localhost:3000/api/keys/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        await fetchKeys();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert('API Key copied to clipboard!');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div className="glass-panel">
        <h2 style={{ marginBottom: '0.5rem' }}>Generate New Key</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
          Create an API key to securely connect Claude Desktop or other clients to your memory index.
        </p>
        
        <form onSubmit={handleGenerate} style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
            <label className="form-label">Key Label / Name</label>
            <input 
              type="text" 
              className="form-input" 
              placeholder="e.g. Claude Desktop Mac" 
              value={newKeyName}
              onChange={e => setNewKeyName(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={generating || !newKeyName.trim()}>
            {generating ? 'Creating...' : 'Create Secret Key'}
          </button>
        </form>

        {newlyGeneratedKey && (
          <div className="animate-fade-in" style={{ marginTop: '1.5rem', padding: '1.5rem', background: 'rgba(14, 165, 233, 0.1)', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '12px' }}>
            <div style={{ fontWeight: 600, color: 'var(--accent-secondary)', marginBottom: '0.5rem' }}>Save this key now!</div>
            <p style={{ fontSize: '0.9rem', marginBottom: '1rem', color: 'var(--text-secondary)' }}>For security reasons, you will <strong>never</strong> see this key again after securely closing this prompt. It has been irreversible hashed in our database.</p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <code style={{ flex: 1, padding: '0.75rem', background: 'rgba(0,0,0,0.5)', borderRadius: '8px', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                {newlyGeneratedKey}
              </code>
              <button type="button" className="btn btn-secondary" onClick={() => copyToClipboard(newlyGeneratedKey)}>
                Copy
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="glass-panel">
        <h2 style={{ marginBottom: '1.5rem' }}>Active Keys</h2>
        
        {loading ? (
          <div style={{ color: 'var(--text-secondary)' }}>Loading...</div>
        ) : keys.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)' }}>You don't have any active API keys.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {keys.map(k => (
              <div key={k.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                <div>
                  <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{k.name}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', gap: '1rem' }}>
                    <span>Created: {new Date(k.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <button type="button" onClick={() => handleDelete(k.id)} className="btn-ghost" style={{ color: '#ef4444' }}>
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
