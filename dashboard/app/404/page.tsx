import { NotFoundView } from "../components/not-found-view";

export default function FourOhFourPage() {
  return (
    <NotFoundView
      title="Nothing here"
      description="This route is unavailable. Head back home or sign in to continue."
    />
  );
}
