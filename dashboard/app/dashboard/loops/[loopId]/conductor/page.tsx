"use client";

import { useParams } from "next/navigation";

import { ConductorBuilder } from "@/components/conductor-builder";

export default function ConductorPage() {
  const params = useParams<{ loopId: string }>();
  return <ConductorBuilder loopId={params.loopId} />;
}
