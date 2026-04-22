import Link from "next/link";
import { ArrowRight, Check, X } from "lucide-react";
import { IntegrationsSection } from "./components/integrations-section";



const PRICING_PLANS = [
  {
    key: "free" as const,
    name: "Free",
    price: "$0",
    period: "",
    description: "Get started with basic memory features",
    features: ["50 saves/month", "200 recalls/month", "All 3 AI platforms"],
    href: "/login",
    cta: "Get Tallei",
    featured: false,
  },
  {
    key: "pro" as const,
    name: "Pro",
    price: "$9",
    period: "/mo",
    description: "For developers building with AI memory",
    features: ["5,000 saves/month included", "100,000 recalls/month included", "All 3 AI platforms", "Link memories to PDFs"],
    href: "/login?plan=pro",
    cta: "Get Tallei Pro",
    featured: true,
  },
  {
    key: "power" as const,
    name: "Power",
    price: "$19",
    period: "/mo",
    description: "For teams and production workloads",
    features: ["25,000 saves/month included", "500,000 recalls/month included", "API access + export", "Priority support"],
    href: "/login?plan=power",
    cta: "Get Tallei Power",
    featured: false,
  },
] as const;


/* ─── Component ─────────────────────────────────────────────── */

export function HomeContent() {
  return (
    <div className="landing-root">
      {/* JSON-LD Structured Data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            {
              "@context": "https://schema.org",
              "@type": "WebSite",
              "name": "Tallei",
              "url": "https://tallei.com",
              "description": "Persistent memory sync across ChatGPT, Claude, and Gemini",
              "potentialAction": {
                "@type": "SearchAction",
                "target": {
                  "@type": "EntryPoint",
                  "urlTemplate": "https://tallei.com/?q={search_term_string}",
                },
                "query-input": "required name=search_term_string",
              },
            },
            {
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              "name": "Tallei",
              "applicationCategory": "ProductivityApplication",
              "operatingSystem": "Web",
              "description":
                "Tallei is a shared memory layer for AI assistants. It syncs persistent context across ChatGPT, Claude, and Gemini so you never have to repeat yourself.",
              "url": "https://tallei.com",
              "offers": {
                "@type": "Offer",
                "price": "0",
                "priceCurrency": "USD",
                "description": "Free tier available",
              },
              "featureList": [
                "Sync memory across ChatGPT, Claude, and Gemini",
                "MCP protocol support for Claude Desktop",
                "Encrypted private memory storage",
                "High-volume memory allowances",
                "Automatic context retrieval",
              ],
            },
            {
              "@context": "https://schema.org",
              "@type": "FAQPage",
              "mainEntity": [
                {
                  "@type": "Question",
                  "name": "Is it secure?",
                  "acceptedAnswer": {
                    "@type": "Answer",
                    "text":
                      "Yes. Your memories are encrypted. We don't read them, and we definitely don't train models on them. It's your private data.",
                  },
                },
                {
                  "@type": "Question",
                  "name": "How does it connect?",
                  "acceptedAnswer": {
                    "@type": "Answer",
                    "text":
                      "We use the open MCP protocol for desktop apps (like Claude Desktop) and secure API keys for web environments. Setup takes minutes.",
                  },
                },
                {
                  "@type": "Question",
                  "name": "Is there a limit?",
                  "acceptedAnswer": {
                    "@type": "Answer",
                    "text":
                      "Tallei plans include high monthly allowances designed for normal daily and team workflows, with fair-use protections in place.",
                  },
                },
              ],
            },
            {
              "@context": "https://schema.org",
              "@type": "Organization",
              "name": "Tallei",
              "url": "https://tallei.com",
              "logo": "https://tallei.com/tallei.svg",
              "contactPoint": {
                "@type": "ContactPoint",
                "email": "hello@tallei.com",
                "contactType": "customer support",
              },
              "sameAs": [],
            },
          ]),
        }}
      />

      {/* ═════════════════════════════════════════════════════
          SPLIT SCREEN HERO
      ═════════════════════════════════════════════════════ */}
      <header className="flex flex-col lg:flex-row w-full min-h-screen">
        {/* Left Side */}
        <div className="flex-1 bg-[#fdfbf7] flex flex-col justify-center px-8 sm:px-16 lg:px-24 py-20 lg:py-0 relative z-10">
          <div className="max-w-[540px] mx-auto lg:mx-0 w-full">
            <div className="inline-flex items-center rounded bg-[#eef2ff] text-[#5b3af6] px-3 py-1.5 text-xs font-semibold mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-[#5b3af6] mr-2"></span>
              Sync memory between ChatGPT and Claude
            </div>
            
            <h1 className="text-[3.5rem] sm:text-[4.5rem] leading-[1.05] font-serif text-[#111] mb-6 tracking-tight">
              Make your AI tools<br />actually <span className="italic text-[#666] font-light">talk</span><br />to each other.
            </h1>
            
            <p className="text-[1.05rem] text-[#4c4643] mb-10 leading-[1.6] max-w-[460px]">
              Tallei gives your AI tools a shared memory. Teach ChatGPT how you like things — Claude automatically knows. Stop repeating yourself.
            </p>
            
            <div className="mb-14">
              <Link href="/login" className="inline-flex items-center justify-center bg-[#5b3af6] text-white px-6 py-3.5 rounded text-sm font-semibold hover:bg-[#4f2ce0] transition-colors mb-3">
                Try it for free <ArrowRight size={16} className="ml-2" />
              </Link>
              <p className="text-[0.65rem] text-[#8c827a] font-mono tracking-widest uppercase">
                Takes 2 minutes · No credit card required
              </p>
            </div>

            {/* Mockup */}
            <div className="bg-white border border-[#e5e0d8] rounded-md shadow-sm w-full overflow-hidden">
              <div className="flex items-center px-4 py-3 bg-[#f8f9fa] border-b border-[#e5e0d8]">
                <div className="flex space-x-1.5 mr-4">
                  <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-[#27c93f]"></div>
                </div>
                <div className="text-[0.65rem] font-mono text-[#8c827a] tracking-widest uppercase">
                  Tallei Memory Log
                </div>
              </div>
              
              <div className="flex flex-col">
                <div className="flex items-center px-5 py-4 border-b border-[#e5e0d8] bg-white">
                  <div className="w-6 h-6 flex items-center justify-center border border-[#e5e0d8] rounded mr-4 bg-white flex-shrink-0">
                    <img src="/chatgpt.svg" alt="ChatGPT" className="w-4 h-4 opacity-80" />
                  </div>
                  <span className="text-[0.8rem] text-[#111]">"Always keep my emails short, punchy, and use bullet points."</span>
                </div>
                
                <div className="flex items-center px-5 py-4 border-b border-[#e5e0d8] bg-white">
                  <div className="w-6 h-6 flex items-center justify-center border border-[#e5e0d8] rounded mr-4 bg-white flex-shrink-0">
                    <span className="text-[#d97757] font-serif font-bold text-xs">A</span>
                  </div>
                  <span className="text-[0.8rem] text-[#111]">"Draft a project update for the team."</span>
                </div>
                
                <div className="flex items-center px-5 py-4 border-b border-[#e5e0d8] bg-white">
                  <div className="relative w-8 h-6 mr-3 flex-shrink-0 flex items-center">
                    <div className="w-6 h-6 flex items-center justify-center border border-[#e5e0d8] rounded bg-white absolute left-0 z-10 shadow-sm">
                      <img src="/chatgpt.svg" alt="ChatGPT" className="w-4 h-4 opacity-80" />
                    </div>
                    <div className="w-6 h-6 flex items-center justify-center border border-[#e5e0d8] rounded bg-white absolute left-3 z-20 shadow-sm">
                      <span className="text-[#d97757] font-serif font-bold text-xs">A</span>
                    </div>
                  </div>
                  <span className="text-[0.8rem] text-[#4c4643]">Claude writes a concise, bulleted email — without being told twice.</span>
                </div>
              </div>
              
              <div className="px-5 py-3 bg-[#f4fbf6] flex items-center">
                <Check size={14} className="text-[#10b981] mr-2" />
                <span className="text-[0.7rem] text-[#10b981] font-mono tracking-widest uppercase font-semibold">Synced instantly</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Side */}
        <div className="flex-1  flex flex-col items-center justify-center relative px-8 py-20 lg:py-0 overflow-hidden min-h-[500px]">
          <div className="relative w-full max-w-[600px] flex flex-col items-center z-10">
            <img src="/hero-image-bg.png" alt="Before Tallei" className="w-full h-auto object-contain drop-shadow-2xl" />
            <p className="mt-10 text-[0.65rem] font-mono tracking-[0.2em] text-[#6b7280] uppercase text-center">
              Before Tallei — Every tool, isolated
            </p>
          </div>
        </div>
      </header>

      <IntegrationsSection />
      <section style={{ backgroundColor: '#f6f4f0', padding: '6rem 2rem', display: 'flex', justifyContent: 'center' }} aria-label="Why Tallei">
        <div style={{ maxWidth: 1040, width: '100%' }}>

          {/* Header */}
          <div style={{ marginBottom: '4rem' }}>
            <span style={{ color: '#3b82f6', fontSize: '0.85rem', fontWeight: 600, letterSpacing: '0.15em', textTransform: 'uppercase', fontFamily: 'monospace' }}>Why Tallei</span>
            <h2 style={{ fontFamily: 'Georgia, serif', fontSize: '5rem', color: '#111', lineHeight: 1.05, margin: '1.5rem 0 0.5rem', fontWeight: 400, letterSpacing: '-0.02em' }}>
              Fast. Invisible.<br />
              <span style={{ fontStyle: 'italic', color: '#333' }}>Just works.</span>
            </h2>
            <p style={{ color: '#4b5563', fontSize: '1.15rem', maxWidth: 450, lineHeight: 1.6, marginTop: '2rem' }}>
              No dashboards. No config. Tallei runs quietly in the background.
            </p>
          </div>

          {/* 3 Cards Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', background: '#fff', border: '1px solid #e5e7eb' }}>
            {/* Card 1 */}
            <div style={{ padding: '3.5rem 2.5rem', borderRight: '1px solid #e5e7eb' }}>
              <h3 style={{ fontFamily: 'Georgia, serif', fontSize: '4rem', color: '#111', fontWeight: 400, margin: '0 0 1rem', letterSpacing: '-0.04em' }}>&lt;300ms</h3>
              <p style={{ fontWeight: 600, color: '#111', fontSize: '1rem', margin: '0 0 0.5rem' }}>Blazingly fast</p>
              <p style={{ color: '#6b7280', fontSize: '0.95rem', margin: 0 }}>No spinner. No wait.</p>
            </div>

            {/* Card 2 */}
            <div style={{ padding: '3.5rem 2.5rem', borderRight: '1px solid #e5e7eb' }}>
              <h3 style={{ fontFamily: 'Georgia, serif', fontSize: '4rem', color: '#111', fontWeight: 400, margin: '0 0 1rem', letterSpacing: '-0.04em' }}>Any AI</h3>
              <p style={{ fontWeight: 600, color: '#111', fontSize: '1rem', margin: '0 0 0.5rem' }}>Your tools, your choice</p>
              <p style={{ color: '#6b7280', fontSize: '0.95rem', margin: '0 0 1.5rem' }}>All in sync. Always.</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <img src="/chatgpt.svg" alt="ChatGPT" width={24} height={24} />
                <img src="/claude.svg" alt="Claude" width={24} height={24} />
                <img src="/gemini.svg" alt="Gemini" width={24} height={24} />
                <span style={{ fontSize: '0.85rem', color: '#6b7280', marginLeft: '0.25rem' }}>+ more</span>
              </div>
            </div>

            {/* Card 3 */}
            <div style={{ padding: '3.5rem 2.5rem' }}>
              <h3 style={{ fontFamily: 'Georgia, serif', fontSize: '4rem', color: '#111', fontWeight: 400, margin: '0 0 1rem', letterSpacing: '-0.04em' }}>Zero</h3>
              <p style={{ fontWeight: 600, color: '#111', fontSize: '1rem', margin: '0 0 0.5rem' }}>Zero setup</p>
              <p style={{ color: '#6b7280', fontSize: '0.95rem', margin: 0 }}>Minutes to connect. Nothing to maintain.</p>
            </div>
          </div>

                    {/* ═════════════════════════════════════════════════════
              FEATURE GRID (Dark Mode / Flaticon Style)
          ═════════════════════════════════════════════════════ */}
          <div style={{
            marginTop: '4rem',
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gridTemplateRows: "auto auto",
            gap: "2px",
            background: "oklch(87% 0.008 265)",
            textAlign: 'left'
          }}>

            {/* Card 1: Save memory */}
            <div style={{
              background: "oklch(10% 0.016 272)",
              padding: "2.5rem",
              display: "flex",
              flexDirection: "column",
              position: "relative",
              overflow: "hidden",
              minHeight: "340px"
            }}>
              <div style={{ flex: 1, display: "flex", alignItems: "flex-start", marginBottom: "2rem", minHeight: "160px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", paddingTop: "0.25rem", width: "100%", maxWidth: "300px" }}>
                  <div style={{ background: "oklch(14% 0.014 272)", border: `1px solid oklch(20% 0.014 272)`, padding: "0.8rem", display: "flex", flexDirection: "column", gap: "0.5rem", borderRadius: "4px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.15rem" }}>
                      <img src="/chatgpt.svg" alt="ChatGPT" width={14} height={14} style={{ filter: 'brightness(0) invert(1) opacity(0.8)' }} />
                      <span style={{ fontSize: "0.65rem", fontFamily: "'DM Mono', monospace, sans-serif", letterSpacing: "0.06em", color: "oklch(55% 0.010 265)", textTransform: "uppercase" }}>ChatGPT</span>
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "oklch(85% 0.008 265)", lineHeight: 1.45 }}>
                      Always use <strong style={{ color: "white", fontWeight: "600" }}>TypeScript strict mode</strong> and avoid any-types in new files.
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", marginTop: "0.2rem" }}>
                      <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: "oklch(62% 0.16 278)" }}></div>
                      <span style={{ fontSize: "0.6rem", fontFamily: "'DM Mono', monospace, sans-serif", letterSpacing: "0.07em", color: "oklch(62% 0.16 278)", textTransform: "uppercase" }}>Captured by Tallei</span>
                    </div>
                  </div>
                  <div style={{ background: "oklch(14% 0.014 272)", border: `1px solid oklch(20% 0.014 272)`, padding: "0.8rem", opacity: 0.45, display: "flex", flexDirection: "column", gap: "0.4rem", borderRadius: "4px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <img src="/claude.svg" alt="Claude" width={14} height={14} style={{ filter: 'brightness(0) invert(1) opacity(0.8)' }} />
                      <span style={{ fontSize: "0.65rem", fontFamily: "'DM Mono', monospace, sans-serif", letterSpacing: "0.06em", color: "oklch(55% 0.010 265)", textTransform: "uppercase" }}>Claude</span>
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "oklch(85% 0.008 265)", lineHeight: 1.45 }}>Net-30 terms, IP transfers on final payment only.</div>
                  </div>
                </div>
              </div>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: "1.5rem", color: "oklch(90% 0.008 265)", marginBottom: "0.5rem", fontWeight: 400 }}>Save memory from anywhere</div>
              <div style={{ fontSize: "0.85rem", color: "oklch(55% 0.010 265)", lineHeight: 1.55, maxWidth: "340px" }}>Preferences, decisions, and context — captured from every tool you use.</div>
            </div>

            {/* Card 2: Workflow */}
            <div style={{
              background: "oklch(10% 0.016 272)",
              padding: "2.5rem",
              display: "flex",
              flexDirection: "column",
              position: "relative",
              overflow: "hidden",
              minHeight: "340px"
            }}>
              <div style={{ flex: 1, display: "flex", alignItems: "flex-start", marginBottom: "2rem", minHeight: "160px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%", paddingTop: "0.25rem", maxWidth: "300px" }}>
                  <div style={{ background: "oklch(14% 0.014 272)", border: `1px solid oklch(20% 0.014 272)`, padding: "0.8rem 1rem", display: "flex", flexDirection: "column", gap: "0.4rem", borderRadius: "4px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "oklch(62% 0.16 278)", flexShrink: 0 }}></div>
                      <span style={{ fontFamily: "'DM Mono', monospace, sans-serif", fontSize: "0.6rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "oklch(62% 0.16 278)" }}>Memory injected</span>
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "oklch(85% 0.008 265)", lineHeight: 1.4, paddingLeft: "0.8rem" }}>Always output TypeScript with strict mode enabled</div>
                  </div>
                  <div style={{ background: "oklch(14% 0.014 272)", border: `1px solid oklch(20% 0.014 272)`, padding: "0.8rem 1rem", display: "flex", flexDirection: "column", gap: "0.4rem", opacity: 0.45, borderRadius: "4px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "oklch(28% 0.012 272)", flexShrink: 0 }}></div>
                      <span style={{ fontFamily: "'DM Mono', monospace, sans-serif", fontSize: "0.6rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "oklch(55% 0.010 265)" }}>Earlier today</span>
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "oklch(55% 0.010 265)", lineHeight: 1.4, paddingLeft: "0.8rem" }}>Use the Notion API for all document storage</div>
                  </div>
                </div>
              </div>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: "1.5rem", color: "oklch(90% 0.008 265)", marginBottom: "0.5rem", fontWeight: 400 }}>Watch your workflow speed up</div>
              <div style={{ fontSize: "0.85rem", color: "oklch(55% 0.010 265)", lineHeight: 1.55, maxWidth: "340px" }}>Tallei injects your context exactly when ChatGPT or Claude need it.</div>
            </div>

            {/* Card 3: Talk */}
            <div style={{
              background: "oklch(10% 0.016 272)",
              padding: "2.5rem",
              display: "flex",
              flexDirection: "column",
              position: "relative",
              overflow: "hidden",
              minHeight: "340px"
            }}>
              <div style={{ flex: 1, display: "flex", alignItems: "flex-start", marginBottom: "2rem", minHeight: "160px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", width: "100%", paddingTop: "0.25rem", maxWidth: "300px" }}>
                  <div style={{ background: "oklch(15% 0.04 278)", borderColor: "oklch(36% 0.10 278)", border: "1px solid oklch(30% 0.10 278)", padding: "0.6rem 0.8rem", display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem", color: "oklch(85% 0.008 265)", borderRadius: "4px" }}>
                    <svg style={{ width: "14px", height: "14px", flexShrink: 0, color: "oklch(62% 0.16 278)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    What did I decide for the API?
                  </div>
                  <div style={{ background: "oklch(14% 0.014 272)", border: `1px solid oklch(20% 0.014 272)`, padding: "0.6rem 0.8rem", display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem", color: "oklch(85% 0.008 265)", borderRadius: "4px" }}>
                    <svg style={{ width: "14px", height: "14px", flexShrink: 0, opacity: 0.4 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    How should I structure the PR?
                  </div>
                  <div style={{ background: "oklch(14% 0.014 272)", border: `1px solid oklch(20% 0.014 272)`, padding: "0.6rem 0.8rem", display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem", color: "oklch(85% 0.008 265)", opacity: 0.4, borderRadius: "4px" }}>
                    <svg style={{ width: "14px", height: "14px", flexShrink: 0, opacity: 0.4 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    What&apos;s the agreed rate for the agency?
                  </div>
                </div>
              </div>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: "1.5rem", color: "oklch(90% 0.008 265)", marginBottom: "0.5rem", fontWeight: 400 }}>Talk to everything you&apos;ve saved</div>
              <div style={{ fontSize: "0.85rem", color: "oklch(55% 0.010 265)", lineHeight: 1.55, maxWidth: "340px" }}>Ask questions across all your memories. Instant answers from past decisions.</div>
            </div>

            {/* Card 4: Organize (wide, spans 3 columns) */}
            <div style={{
              background: "oklch(10% 0.016 272)",
              padding: "2.5rem",
              display: "flex",
              flexDirection: "column",
              position: "relative",
              overflow: "hidden",
              minHeight: "340px",
              gridColumn: "span 3"
            }}>
              <div style={{ flex: 1, display: "flex", alignItems: "flex-start", marginBottom: "2rem", minHeight: "160px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", paddingTop: "0.25rem", width: "100%", maxWidth: "700px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", background: "oklch(14% 0.014 272)", border: `1px solid oklch(20% 0.014 272)`, padding: "0.7rem 1rem", borderRadius: "4px" }}>
                    <span style={{ fontSize: "0.85rem", color: "oklch(85% 0.008 265)", flex: 1 }}>Always use TypeScript strict mode</span>
                    <span style={{ fontSize: "0.6rem", fontFamily: "'DM Mono', monospace, sans-serif", letterSpacing: "0.07em", textTransform: "uppercase", padding: "0.2rem 0.5rem", background: "oklch(22% 0.05 200)", color: "oklch(62% 0.14 185)", border: "1px solid oklch(30% 0.08 185)", borderRadius: "2px" }}>Code style</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", background: "oklch(14% 0.014 272)", border: `1px solid oklch(20% 0.014 272)`, padding: "0.7rem 1rem", borderRadius: "4px" }}>
                    <span style={{ fontSize: "0.85rem", color: "oklch(85% 0.008 265)", flex: 1 }}>Net-30, IP transfers on final payment</span>
                    <span style={{ fontSize: "0.6rem", fontFamily: "'DM Mono', monospace, sans-serif", letterSpacing: "0.07em", textTransform: "uppercase", padding: "0.2rem 0.5rem", background: "oklch(22% 0.05 60)", color: "oklch(68% 0.14 65)", border: "1px solid oklch(30% 0.08 65)", borderRadius: "2px" }}>Decision</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", background: "oklch(14% 0.014 272)", border: `1px solid oklch(20% 0.014 272)`, padding: "0.7rem 1rem", borderRadius: "4px" }}>
                    <span style={{ fontSize: "0.85rem", color: "oklch(85% 0.008 265)", flex: 1 }}>Team prefers async over sync stand-ups</span>
                    <span style={{ fontSize: "0.6rem", fontFamily: "'DM Mono', monospace, sans-serif", letterSpacing: "0.07em", textTransform: "uppercase", padding: "0.2rem 0.5rem", background: "oklch(22% 0.06 278)", color: "oklch(62% 0.16 278)", border: "1px solid oklch(32% 0.10 278)", borderRadius: "2px" }}>Preference</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", background: "oklch(14% 0.014 272)", border: `1px solid oklch(20% 0.014 272)`, padding: "0.7rem 1rem", opacity: 0.4, borderRadius: "4px" }}>
                    <span style={{ fontSize: "0.85rem", color: "oklch(85% 0.008 265)", flex: 1 }}>Agency contract v3 — final scope locked</span>
                    <span style={{ fontSize: "0.6rem", fontFamily: "'DM Mono', monospace, sans-serif", letterSpacing: "0.07em", textTransform: "uppercase", padding: "0.2rem 0.5rem", background: "oklch(22% 0.05 320)", color: "oklch(68% 0.12 320)", border: "1px solid oklch(30% 0.08 320)", borderRadius: "2px" }}>Document</span>
                  </div>
                </div>
              </div>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: "1.5rem", color: "oklch(90% 0.008 265)", marginBottom: "0.5rem", fontWeight: 400 }}>Organize without thinking</div>
              <div style={{ fontSize: "0.85rem", color: "oklch(55% 0.010 265)", lineHeight: 1.55, maxWidth: "340px" }}>Tallei categorizes and surfaces the right memory automatically — you never touch a folder.</div>
            </div>

          </div>

        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          FEATURES — Honest, simple narrative
      ═════════════════════════════════════════════════════ */}
      <section className="features-section">
        <div className="features-inner">
          <h2 className="section-h2">Why we built this</h2>

          <div className="story-grid">
            <div className="story-card">
              <div className="story-num">01</div>
              <h3 className="story-h3">The blank slate sucks</h3>
              <p className="story-p">
                Every time you switch from ChatGPT to Claude, it&apos;s like meeting someone for the first time. You have to explain your business, your tone of voice, and your rules all over again. It&apos;s exhausting.
              </p>
            </div>

            <div className="story-card">
              <div className="story-num">02</div>
              <h3 className="story-h3">Stop copy-pasting</h3>
              <p className="story-p">
                Right now, you&apos;re acting as the messenger between two supercomputers. Copying custom instructions from one chat to paste into another is busywork you shouldn&apos;t be doing.
              </p>
            </div>

            <div className="story-card">
              <div className="story-num">03</div>
              <h3 className="story-h3">Teach one, both learn</h3>
              <p className="story-p">
                Tallei sits quietly in the background. If you tell ChatGPT how you prefer your weekly reports formatted, Claude will automatically know it for your next project. It&apos;s just one continuous memory.
              </p>
            </div>
          </div>
        </div>
      </section>

{/* ═════════════════════════════════════════════════════
          PRICING
      ═════════════════════════════════════════════════════ */}
      <section
        id="pricing"
        style={{
          padding: "5rem 0 6rem",
          background: "#fdfbf7",
          borderTop: "2px solid #e5e0d8",
        }}
      >
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 1.5rem" }}>
          <h2
            style={{
              fontSize: "2rem",
              fontWeight: 700,
              textAlign: "center",
              color: "#0f172a",
              marginBottom: "0.75rem",
            }}
          >
            Simple, transparent pricing
          </h2>
          <p
            style={{
              maxWidth: 500,
              margin: "0 auto 2.5rem",
              color: "#64748b",
              fontSize: "1rem",
              lineHeight: 1.6,
              textAlign: "center",
            }}
          >
            Start free, upgrade when you need more. All paid plans include a 14-day free trial.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "1rem",
            }}
          >
            {PRICING_PLANS.map((plan) => (
              <article
                key={plan.key}
                style={{
                  background: "#ffffff",
                  border: plan.featured ? "2px solid #5b21b6" : "2px solid #e5e0d8",
                  borderRadius: 4,
                  padding: "1.5rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "1rem",
                  boxShadow: plan.featured ? "4px 4px 0px #e1d4fc" : "4px 4px 0px #e5e0d8",
                }}
              >
                {/* Plan Badge Row */}
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: plan.featured ? "#5b21b6" : "#8c827a",
                    }}
                  >
                    {plan.name}
                  </span>
                  {plan.featured && (
                    <span
                      style={{
                        fontSize: "0.7rem",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        color: "#5b21b6",
                        border: "2px solid #5b21b6",
                        background: "#fdfbf7",
                        borderRadius: 999,
                        padding: "0.15rem 0.5rem",
                      }}
                    >
                      Most popular
                    </span>
                  )}
                </div>

                {/* Price */}
                <div>
                  <div style={{ fontSize: "2rem", fontWeight: 700, color: "#0f172a", lineHeight: 1.2 }}>
                    {plan.price}
                    {plan.period && (
                      <span style={{ fontSize: "1rem", fontWeight: 500, color: "#8c827a", marginLeft: "0.15rem" }}>
                        {plan.period}
                      </span>
                    )}
                  </div>
                  <p style={{ margin: "0.5rem 0 0", fontSize: "0.875rem", color: "#4c4643", lineHeight: 1.5 }}>
                    {plan.description}
                  </p>
                </div>

                {/* Features */}
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                  {plan.features.map((feature) => (
                    <li
                      key={feature}
                    style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", color: "#334155", fontSize: "0.875rem", lineHeight: 1.5 }}
                  >
                      <Check size={16} style={{ color: "#7c3aed", flexShrink: 0, marginTop: "0.1rem" }} />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <div style={{ marginTop: "auto", paddingTop: "0.5rem" }}>
                  <Link
                    href={plan.href}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "0.4rem",
                      padding: "0.75rem 1rem",
                      borderRadius: 4,
                      fontSize: "0.875rem",
                      fontWeight: 600,
                      textDecoration: "none",
                      transition: "all 0.15s ease",
                      background: plan.featured ? "#7c3aed" : "#ffffff",
                      color: plan.featured ? "#ffffff" : "#0f172a",
                      border: plan.featured ? "2px solid #5b21b6" : "2px solid #e5e0d8",
                      boxShadow: plan.featured ? "3px 3px 0px #e1d4fc" : "3px 3px 0px #e5e0d8",
                    }}
                  >
                    {plan.cta}
                    <ArrowRight size={14} />
                  </Link>
                  {!plan.featured && plan.key !== "free" && (
                    <p style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "#94a3b8", textAlign: "center" }}>
                      14-day free trial
                    </p>
                  )}
                  {plan.featured && (
                    <p style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "#94a3b8", textAlign: "center" }}>
                      14-day free trial
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          FAQ / DETAILS
      ═════════════════════════════════════════════════════ */}
      <section className="faq-section">
        <div className="faq-inner">
          <h2 className="section-h2 text-center">The details</h2>
          <ul className="faq-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            <li className="solid-card detail-card">
              <h3 className="detail-h4">Is it secure?</h3>
              <p className="detail-p">
                Yes. Your memories are encrypted. We don&apos;t read them, and we definitely
                don&apos;t train models on them. It&apos;s your private data.
              </p>
            </li>
            <li className="solid-card detail-card">
              <h3 className="detail-h4">How does it connect?</h3>
              <p className="detail-p">
                We use the open MCP protocol for desktop apps (like Claude Desktop) and
                secure API keys for web environments. Setup takes minutes.
              </p>
            </li>
            <li className="solid-card detail-card">
              <h3 className="detail-h4">Is there a limit?</h3>
              <p className="detail-p">
                No. Save as many facts, preferences, and details as you need. Tallei
                automatically retrieves only what&apos;s relevant to your current conversation.
              </p>
            </li>
          </ul>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          CTA
      ═════════════════════════════════════════════════════ */}
      <section className="cta-section">
        <div className="cta-inner">
          <div className="solid-card cta-card">
            <h2 className="section-h2 text-center mt-0">Stop repeating yourself.</h2>
            <p className="cta-sub">
              Give your AI tools a shared memory, and stop acting as the middleman.
            </p>
            <Link href="/login" className="landing-btn landing-btn-large">
              Start syncing your AI
            </Link>
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          FOOTER
      ═════════════════════════════════════════════════════ */}
      <footer className="footer-section">
        <div className="footer-inner">
          <div className="footer-brand">
            <img src="/tallei.svg" alt="Tallei logo" width={24} height={24} />
          </div>
          <div className="footer-links">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms of Service</Link>
            <a href="mailto:hello@tallei.com">Contact</a>
            <a href="https://github.com/Dinuda/tallei-ai" target="_blank" rel="noopener noreferrer" className="footer-link-open-source">Open Source</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
