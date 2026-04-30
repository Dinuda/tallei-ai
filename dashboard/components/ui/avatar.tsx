"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const avatarVariants = cva(
  "relative flex shrink-0 overflow-hidden rounded-full",
  {
    variants: {
      size: {
        sm: "h-8 w-8",
        default: "h-10 w-10",
        lg: "h-14 w-14",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
);

export interface AvatarProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof avatarVariants> {}

const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ className, size, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(avatarVariants({ size }), className)}
      {...props}
    />
  )
);
Avatar.displayName = "Avatar";

interface AvatarImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  onLoadingStatusChange?: (status: "loading" | "loaded" | "error") => void;
}

const AvatarImage = React.forwardRef<HTMLImageElement, AvatarImageProps>(
  ({ className, src, alt, onLoadingStatusChange, ...props }, ref) => {
    const [status, setStatus] = React.useState<"loading" | "loaded" | "error">(
      "loading"
    );

    if (!src || status === "error") return null;

    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        ref={ref}
        src={src}
        alt={alt}
        className={cn("aspect-square h-full w-full object-cover", className)}
        onLoad={() => {
          setStatus("loaded");
          onLoadingStatusChange?.("loaded");
        }}
        onError={() => {
          setStatus("error");
          onLoadingStatusChange?.("error");
        }}
        {...props}
      />
    );
  }
);
AvatarImage.displayName = "AvatarImage";

const AvatarFallback = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex h-full w-full items-center justify-center rounded-full bg-[var(--border-light)] text-[var(--text-2)] text-xs font-semibold uppercase tracking-wide",
      className
    )}
    {...props}
  />
));
AvatarFallback.displayName = "AvatarFallback";

export { Avatar, AvatarImage, AvatarFallback };
