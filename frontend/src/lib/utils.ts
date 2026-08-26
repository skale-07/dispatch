import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** The shadcn convention: registry components import { cn } from "@/lib/utils". */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
