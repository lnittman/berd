import { describe, expect, it } from "vitest";
import type { AuthStatus } from "@/features/auth/api/auth";
import { persistenceIdentityFromAuthStatus } from "./elicitationPersistence";

const authenticatedStatus: AuthStatus = {
  loggedIn: true,
  requiresOrg: false,
  profile: "default",
  kgooseBaseUrl: "http://localhost",
  userId: "user-1",
  org: "org-routing-context",
};

describe("persistenceIdentityFromAuthStatus", () => {
  it("keeps auth-disabled local persistence in one explicit local scope", () => {
    expect(persistenceIdentityFromAuthStatus(undefined)).toEqual({
      accountId: "local",
      workspaceId: "local",
    });
  });

  it("uses an exact authenticated account and workspace boundary", () => {
    expect(
      persistenceIdentityFromAuthStatus({
        ...authenticatedStatus,
        workspaceIdentifier: "workspace-1",
      }),
    ).toEqual({ accountId: "user-1", workspaceId: "workspace-1" });
  });

  it("fails closed when workspace discovery is unavailable", () => {
    expect(persistenceIdentityFromAuthStatus(authenticatedStatus)).toBeNull();
  });

  it("does not treat a shared display name as an account boundary", () => {
    const displayNameOnly = {
      ...authenticatedStatus,
      userId: null,
      email: null,
      user: "Alex",
      name: "Alex",
      workspaceIdentifier: "workspace-1",
    };

    expect(persistenceIdentityFromAuthStatus(displayNameOnly)).toBeNull();
    expect(
      persistenceIdentityFromAuthStatus({
        ...displayNameOnly,
        user: "Alex",
        name: "Alex",
      }),
    ).toBeNull();
  });

  it("fails closed for a signed-out authenticated profile", () => {
    expect(
      persistenceIdentityFromAuthStatus({
        ...authenticatedStatus,
        loggedIn: false,
        workspaceIdentifier: "workspace-1",
      }),
    ).toBeNull();
  });

  it("accepts the authoritative workspace returned by a completed switch", () => {
    expect(
      persistenceIdentityFromAuthStatus(authenticatedStatus, "workspace-2"),
    ).toEqual({ accountId: "user-1", workspaceId: "workspace-2" });
  });
});
