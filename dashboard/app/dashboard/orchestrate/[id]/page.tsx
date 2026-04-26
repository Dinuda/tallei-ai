import { redirect } from "next/navigation";

export default async function OrchestrateSessionRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/dashboard/collab/plan/${id}`);
}
