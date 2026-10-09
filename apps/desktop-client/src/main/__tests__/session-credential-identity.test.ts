import { expect, it } from "vitest";
import { sessionCredentialSigningIdentity } from "../session-credential-identity";

it("keeps a Developer ID identity across updates, while distinguishing ad-hoc builds", () => {
  const release = "Identifier=com.asklins.astella\nAuthority=Developer ID Application: Example (TEAM1)\nTeamIdentifier=TEAM1\nCDHash=abc123\n";
  expect(sessionCredentialSigningIdentity(release)).toBe("developer-id:TEAM1:com.asklins.astella");
  expect(sessionCredentialSigningIdentity(release.replace("abc123", "def456"))).toBe(sessionCredentialSigningIdentity(release));
  const adhoc = "Identifier=com.asklins.astella\nSignature=adhoc\nTeamIdentifier=not set\nCDHash=abc123\n";
  expect(sessionCredentialSigningIdentity(adhoc)).toBe("adhoc:com.asklins.astella:abc123");
  expect(sessionCredentialSigningIdentity(adhoc.replace("abc123", "def456"))).not.toBe(sessionCredentialSigningIdentity(adhoc));
  expect(sessionCredentialSigningIdentity("unsigned")).toBeNull();
});
