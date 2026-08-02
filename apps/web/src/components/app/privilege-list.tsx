import type { PrivilegeCheck } from "@repo/contracts";

export function PrivilegeList({ privileges }: { privileges: readonly PrivilegeCheck[] }) {
  return (
    <ul className="mt-2 space-y-0.5 text-xs">
      {privileges.map((privilege) => (
        <li key={privilege.key} className="flex gap-2">
          <span className={privilege.granted ? "text-primary" : "text-red-600"}>
            {privilege.granted ? "✓" : "✗"}
          </span>
          <span className={privilege.granted ? "" : "font-medium"}>
            {privilege.label}
            {privilege.granted ? null : (
              <span className="font-normal text-muted-foreground"> — {privilege.enables}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
