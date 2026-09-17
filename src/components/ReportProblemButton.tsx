"use client";

import type { ReactNode } from "react";

type ReportProblemButtonProps = {
  children?: ReactNode;
  className?: string;
};

function openFeedbackOrMailto(): void {
  if (typeof window === "undefined") return;
  const open = (
    window as unknown as { openSentryFeedback?: () => void }
  ).openSentryFeedback;
  if (typeof open === "function") {
    open();
    return;
  }
  window.location.href = "mailto:mail@jays.services?subject=Report%20a%20Problem";
}

/** Subtle Sentry feedback trigger.  Falls back to mailto when Sentry is dark. */
export function ReportProblemButton({
  children = "Report a Problem",
  className,
}: ReportProblemButtonProps) {
  return (
    <button type="button" onClick={openFeedbackOrMailto} className={className}>
      {children}
    </button>
  );
}
