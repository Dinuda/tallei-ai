import { redirect } from "next/navigation";

export default async function LegacyBuilderRedirect({
  params,
}: {
  params: Promise<{ loopId: string }>;
}) {
  const { loopId } = await params;
  redirect(`/dashboard/loops/${loopId}/conductor`);
}
