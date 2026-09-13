import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Switch({ className, size = "default", ...props }: React.ComponentProps<typeof SwitchPrimitive.Root> & { size?: "sm" | "default" }) {
  return <SwitchPrimitive.Root data-slot="switch" data-size={size}
    className={cn(
      "peer relative inline-flex shrink-0 items-center rounded-full border border-input bg-input transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary",
      size === "sm" ? "h-5 w-9" : "h-6 w-11", className,
    )} {...props}>
    <SwitchPrimitive.Thumb data-slot="switch-thumb" className={cn(
      "pointer-events-none block rounded-full bg-foreground shadow-sm transition-transform data-[state=checked]:bg-primary-foreground",
      size === "sm" ? "h-4 w-4 translate-x-0.5 data-[state=checked]:translate-x-4" : "h-5 w-5 translate-x-0.5 data-[state=checked]:translate-x-5",
    )} />
  </SwitchPrimitive.Root>;
}
export { Switch };
