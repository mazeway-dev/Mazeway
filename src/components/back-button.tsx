"use client";

import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

export function BackButton() {
  const router = useRouter();

  return (
    <Button
      variant="ghost"
      onClick={() => router.back()}
      className="flex items-center gap-2"
    >
      <ChevronLeft className="size-4" />
      Back
    </Button>
  );
}
