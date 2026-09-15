import type { ReactNode } from "react";
import { AdvancedDetails } from "./AdvancedDetails.js";

/** Evidence starts closed on every visit; diagnostic text never expands from a saved preference. */
export function AdvancedEvidence({
  children,
  title = "高级证据",
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <AdvancedDetails summary={<span>{title}</span>}>
      <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</div>
    </AdvancedDetails>
  );
}
