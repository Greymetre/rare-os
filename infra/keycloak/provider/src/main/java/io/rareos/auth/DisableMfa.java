package io.rareos.auth;
public final class DisableMfa extends ManageMfa {
  @Override public String getId() { return "RARE_DISABLE_MFA"; }
  @Override public String getDisplayText() { return "Turn off authenticator MFA"; }
  @Override protected boolean disableOnly() { return true; }
}
