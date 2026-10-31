import type { MouseEventHandler } from "react";
import "./page-heading.css";

export type BreadcrumbItem = { label: string; href?: string; onClick?: MouseEventHandler<HTMLAnchorElement> };
export function Breadcrumbs({ items, className = "" }: { items: readonly BreadcrumbItem[]; className?: string }) {
  return <nav className={`vorton-breadcrumbs ${className}`} aria-label="Breadcrumb"><ol>{items.map((item, index) => <li key={`${index}:${item.label}`}>
    {index > 0 && <span className="vorton-breadcrumb-caret" aria-hidden="true">›</span>}
    {index === items.length - 1 ? <span aria-current="page">{item.label}</span> : item.href ? <a href={item.href} onClick={item.onClick}>{item.label}</a> : <span>{item.label}</span>}
  </li>)}</ol></nav>;
}
