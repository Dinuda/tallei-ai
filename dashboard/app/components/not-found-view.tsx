import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type NotFoundViewProps = {
  title?: string;
  description?: string;
};

export function NotFoundView({
  title = "Page not found",
  description = "The page you requested does not exist or may have moved.",
}: NotFoundViewProps) {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-2xl items-center justify-center px-4 py-12">
      <Card className="w-full">
        <CardHeader className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">404</p>
          <CardTitle className="text-2xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button asChild>
            <Link href="/">Go home</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
