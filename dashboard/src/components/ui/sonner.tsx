"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
  return <Sonner richColors closeButton toastOptions={{ duration: 3500 }} {...props} />;
}

export { Toaster };
