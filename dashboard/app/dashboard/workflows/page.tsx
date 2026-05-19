"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type WorkflowConversation = {
  id: string;
  title: string;
  status: "draft" | "saved" | "archived";
  updatedAt: string;
  messageCount: number;
};

export default function WorkflowsPage() {
  const [conversations, setConversations] = useState<WorkflowConversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/workflows")
      .then((res) => res.json())
      .then((data) => {
        setConversations(data.sessions ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col">
      <div className="border-b border-slate-200 bg-white px-6 py-5">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-slate-900">Workflows</h1>
              <p className="mt-1 text-sm text-slate-500">Build and manage automated workflows with AI</p>
            </div>
            <Button asChild className="rounded-none bg-indigo-600 text-white hover:bg-indigo-700">
              <Link href="/dashboard/workflows/new">
                <Plus className="mr-1.5 h-4 w-4" />
                New workflow
              </Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 bg-slate-50 px-6 py-8">
        <div className="mx-auto max-w-5xl">
          {conversations.length === 0 ? (
            <Card className="border-slate-200">
              <CardHeader className="text-center pb-2">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50">
                  <Sparkles className="h-6 w-6 text-indigo-600" />
                </div>
                <CardTitle className="text-lg">No workflows yet</CardTitle>
                <CardDescription>
                  Describe what you want to automate and the AI team will build it for you
                </CardDescription>
              </CardHeader>
              <CardContent className="flex justify-center pt-4">
                <Button asChild className="rounded-none bg-indigo-600 text-white hover:bg-indigo-700">
                  <Link href="/dashboard/workflows/new">
                    Create your first workflow
                    <ArrowRight className="ml-1.5 h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {conversations.map((conv) => (
                <Link key={conv.id} href={`/dashboard/workflows/${conv.id}`}>
                  <Card className="group border-slate-200 transition-colors hover:border-indigo-300 hover:shadow-sm">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <CardTitle className="line-clamp-1 text-sm font-medium text-slate-900 group-hover:text-indigo-700">
                          {conv.title || "Untitled workflow"}
                        </CardTitle>
                        <ArrowRight className="ml-2 h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-indigo-600" />
                      </div>
                      <CardDescription className="mt-1 flex items-center gap-2 text-xs">
                        <span
                          className={cn(
                            "inline-block h-1.5 w-1.5 rounded-full",
                            conv.status === "saved" ? "bg-emerald-500" : conv.status === "draft" ? "bg-amber-500" : "bg-slate-400"
                          )}
                        />
                        {conv.status}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <p className="text-xs text-slate-500">
                        {conv.messageCount} messages · {relativeTime(conv.updatedAt)}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function cn(...classes: (string | false | undefined | null)[]) {
  return classes.filter(Boolean).join(" ");
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
