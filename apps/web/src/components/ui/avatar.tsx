import * as React from "react";
import { cn } from "@/lib/utils";

interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  src?: string | null;
  alt?: string;
  initials?: string;
  size?: "xs" | "sm" | "md" | "lg";
}

const sizeClasses = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-9 w-9 text-sm",
  lg: "h-10 w-10 text-base",
};

function Avatar({ src, alt, initials, size = "md", className, ...props }: AvatarProps) {
  return (
    <span
      className={cn(
        "relative inline-flex flex-shrink-0 items-center justify-center rounded-full overflow-hidden select-none",
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt ?? "Avatar"} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-orange-600 font-semibold text-white">
          {initials ?? "?"}
        </span>
      )}
    </span>
  );
}

export { Avatar };
