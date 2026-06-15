"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api-fetch";

type KnowledgeBase = {
  id: string;
  name: string;
  kind: "custom_faq" | "google_doc";
  entryCount: number;
};

type Entry = {
  id: string;
  question: string;
  answer: string;
};

export default function WorkspaceKnowledgePage() {
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [activeKbId, setActiveKbId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [faqName, setFaqName] = useState("");
  const [docName, setDocName] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [docText, setDocText] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");

  async function loadBindings() {
    const response = await apiFetch("/api/knowledge-bases", { cache: "no-store" });
    const payload = await response.json();
    const rows = Array.isArray(payload.knowledgeBases) ? payload.knowledgeBases as KnowledgeBase[] : [];
    setKnowledgeBases(rows);
    if (!activeKbId && rows[0]) setActiveKbId(rows[0].id);
  }

  async function loadEntries(kbId: string) {
    const response = await apiFetch(`/api/knowledge-bases/${kbId}/entries`, { cache: "no-store" });
    const payload = await response.json();
    setEntries(Array.isArray(payload.entries) ? payload.entries as Entry[] : []);
  }

  useEffect(() => { void loadBindings(); }, []);
  useEffect(() => { if (activeKbId) void loadEntries(activeKbId); }, [activeKbId]);

  async function createFaq() {
    if (!faqName.trim()) return;
    await apiFetch("/api/knowledge-bases", { method: "POST", body: JSON.stringify({ name: faqName, kind: "custom_faq" }) });
    setFaqName("");
    await loadBindings();
  }

  async function createGoogleDocKb() {
    if (!docName.trim()) return;
    await apiFetch("/api/knowledge-bases", {
      method: "POST",
      body: JSON.stringify({ name: docName, kind: "google_doc", config: { url: docUrl, title: docName, cachedText: docText } }),
    });
    setDocName("");
    setDocUrl("");
    setDocText("");
    await loadBindings();
  }

  async function saveEntry() {
    if (!activeKbId || !question.trim() || !answer.trim()) return;
    await apiFetch(`/api/knowledge-bases/${activeKbId}/entries`, {
      method: "POST",
      body: JSON.stringify({ question, answer }),
    });
    setQuestion("");
    setAnswer("");
    await loadEntries(activeKbId);
    await loadBindings();
  }

  async function syncDoc(kbId: string) {
    await apiFetch(`/api/knowledge-bases/${kbId}/sync`, { method: "POST" });
    await loadBindings();
  }

  const activeKb = knowledgeBases.find((kb) => kb.id === activeKbId) ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Knowledge bases</h1>
        <p className="mt-1 text-sm text-slate-500">Optional FAQ collections and Google Docs for this workspace.</p>
      </div>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <h2 className="font-medium">Create FAQ collection</h2>
          <Input value={faqName} onChange={(event) => setFaqName(event.target.value)} placeholder="Support FAQs" />
          <Button onClick={() => void createFaq()}>Create FAQ collection</Button>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <h2 className="font-medium">Link Google Doc</h2>
          <Input value={docName} onChange={(event) => setDocName(event.target.value)} placeholder="Doc title" />
          <Input value={docUrl} onChange={(event) => setDocUrl(event.target.value)} placeholder="Google Doc URL" />
          <textarea className="min-h-24 w-full rounded-md border border-slate-200 p-2 text-sm" value={docText} onChange={(event) => setDocText(event.target.value)} placeholder="Paste doc content for sync (or connect Composio later)" />
          <Button onClick={() => void createGoogleDocKb()}>Add Google Doc</Button>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-4 flex flex-wrap gap-2">
          {knowledgeBases.map((kb) => (
            <Button key={kb.id} variant={kb.id === activeKbId ? "default" : "outline"} onClick={() => setActiveKbId(kb.id)}>
              {kb.name} ({kb.entryCount})
            </Button>
          ))}
        </div>
        {activeKb?.kind === "google_doc" ? (
          <Button variant="outline" onClick={() => void syncDoc(activeKb.id)}>Sync Google Doc into workspace memory</Button>
        ) : null}
        {activeKb?.kind === "custom_faq" ? (
          <div className="space-y-3">
            <Input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Question" />
            <textarea className="min-h-20 w-full rounded-md border border-slate-200 p-2 text-sm" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Answer" />
            <Button onClick={() => void saveEntry()}>Save FAQ entry</Button>
            <div className="space-y-2">
              {entries.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-slate-100 p-3">
                  <div className="font-medium text-slate-900">{entry.question}</div>
                  <div className="text-sm text-slate-600">{entry.answer}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
