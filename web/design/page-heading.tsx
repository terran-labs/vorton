import type { ReactNode } from "react";
import "./page-heading.css";

/** Shared page typography; callers own routes, records and actions. */
export function PageHeading({ title, description, eyebrow, breadcrumbs, actions, id, className = "" }: {
  title: ReactNode; description?: ReactNode; eyebrow?: ReactNode; breadcrumbs?: ReactNode;
  actions?: ReactNode; id?: string; className?: string;
}) {
  return <header className={`vorton-page-heading ${className}`}>
    <div>{breadcrumbs}{eyebrow && <p className="vorton-page-eyebrow">{eyebrow}</p>}<h1 id={id}>{title}</h1>{description && <p className="vorton-page-description">{description}</p>}</div>
    {actions && <div className="vorton-page-actions">{actions}</div>}
  </header>;
}
