import { describe, expect, it } from "vitest";
import { dropRoleStatements } from "./provision";

// Provisioning itself needs a server and is proven in the integration suite.
// What is pinned here is the script handed to whoever has to undo it, because
// that script is the only way out of a cluster carrying an orphaned role — the
// fixed name means provisioning stays refused until the role is gone.
describe("dropRoleStatements", () => {
  // A bare DROP ROLE is refused while the CONNECT and USAGE grants still point
  // at the role, and DROP OWNED BY only clears the database it runs in — both
  // measured on 18.4. So: every database, then the drop.
  it("clears the grants in every database before dropping the role", () => {
    expect(dropRoleStatements("indexterity", ["shop", "billing"])).toBe(
      [
        '\\c "shop"',
        'DROP OWNED BY "indexterity";',
        '\\c "billing"',
        'DROP OWNED BY "indexterity";',
        'DROP ROLE "indexterity";',
      ].join("\n"),
    );
  });

  it("quotes a name that would otherwise fold or break", () => {
    expect(dropRoleStatements("Weird Role", [])).toBe('DROP ROLE "Weird Role";');
  });
});
