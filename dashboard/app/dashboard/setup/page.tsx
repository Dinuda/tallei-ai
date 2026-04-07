'use client';

import { useState } from 'react';

export default function SetupPage() {
  const [copied, setCopied] = useState(false);

  const snippet = `{
  "mcpServers": {
    "tallei": {
      "command": "node",
      "args": [
        "/Users/dinudayaggahavita/Documents/work/tallei-ai/mcp-bridge.js"
      ],
      "env": {
        "AUTHORIZATION": "Bearer <YOUR_API_KEY_HERE>"
      }
    }
  }
}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="glass-panel">
      <h2 style={{ marginBottom: '0.5rem' }}>Client Integrations</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>
        Install the Model Context Protocol block securely in your AI agent.
      </p>
      
      <div style={{ marginBottom: '2rem' }}>
        <h3 style={{ fontSize: '1.25rem', marginBottom: '1rem', color: 'var(--text-primary)' }}>Claude Desktop Setup</h3>
        <ul style={{ paddingLeft: '1.5rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <li>Generate a new API Key in the <strong>API Keys</strong> tab.</li>
          <li>Locate your Claude Desktop Config via <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></li>
          <li>Paste the exact standard block directly into your JSON settings.</li>
        </ul>
        
        <div style={{ position: 'relative' }}>
          <pre style={{ 
            background: '#0d1117', 
            padding: '1.5rem', 
            borderRadius: '12px', 
            border: '1px solid var(--border-color)',
            overflowX: 'auto',
            fontFamily: 'monospace',
            fontSize: '0.9rem',
            color: '#e6edf3'
          }}>
            {snippet}
          </pre>
          <button 
            type="button" 
            onClick={handleCopy}
            className="btn btn-secondary" 
            style={{ position: 'absolute', top: '1rem', right: '1rem', padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            {copied ? 'Copied!' : 'Copy Code'}
          </button>
        </div>
      </div>
      
      <div style={{ marginTop: '3rem', paddingTop: '2rem', borderTop: '1px solid var(--border-color)' }}>
        <h3 style={{ fontSize: '1.25rem', marginBottom: '1rem', color: 'var(--text-primary)' }}>ChatGPT Integration (Coming Soon via OpenAI Actions)</h3>
        <p style={{ color: 'var(--text-secondary)' }}>
          To allow ChatGPT to read your Claude context, we establish an OpenAI Action mapping `http://localhost:3000/api/openapi.json`. Coming soon.
        </p>
      </div>

    </div>
  );
}
