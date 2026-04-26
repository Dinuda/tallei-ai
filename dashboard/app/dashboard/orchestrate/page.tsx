import { redirect } from "next/navigation";

export default function OrchestrateRedirectPage() {
  redirect("/dashboard/collab/new");
}
