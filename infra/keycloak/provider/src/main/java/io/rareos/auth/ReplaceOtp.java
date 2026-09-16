package io.rareos.auth;
import org.keycloak.authentication.*;
import org.keycloak.authentication.requiredactions.UpdateTotp;
import org.keycloak.events.EventType;
public final class ReplaceOtp extends UpdateTotp {
  @Override public String getId() { return "RARE_REPLACE_OTP"; }
  @Override public String getDisplayText() { return "Replace selected authenticator"; }
  @Override public InitiatedActionSupport initiatedActionSupport() { return InitiatedActionSupport.NOT_SUPPORTED; }
  @Override public void requiredActionChallenge(RequiredActionContext c) {
    if (!Devices.owns(c.getUser(), c.getAuthenticationSession().getAuthNote(Devices.REPLACE))) { c.failure("Authenticator changed. Start the reset again."); return; }
    c.form().setInfo("Scan the new QR code. Your selected old authenticator will stop working only after the new code is verified. Other devices stay active.");
    c.form().setAttribute("rareReplacement", true);
    super.requiredActionChallenge(c);
  }
  @Override public void processAction(RequiredActionContext c) {
    String old = c.getAuthenticationSession().getAuthNote(Devices.REPLACE);
    if (!Devices.owns(c.getUser(), old)) { c.failure("Authenticator changed. Start the reset again."); return; }
    var before = Devices.otp(c.getUser()).stream().map(x -> x.getId()).toList();
    c.form().setAttribute("rareReplacement", true);
    super.processAction(c);
    if (c.getStatus() == RequiredActionContext.Status.SUCCESS) {
      if (Devices.otp(c.getUser()).stream().noneMatch(x -> !before.contains(x.getId()))) { throw new IllegalStateException("Replacement not created"); }
      // Create and revoke within the same Keycloak transaction; failed enrollment keeps old OTP.
      c.getUser().credentialManager().removeStoredCredentialById(old);
      c.getAuthenticationSession().removeAuthNote(Devices.REPLACE);
      c.getEvent().clone().event(EventType.REMOVE_CREDENTIAL).detail("credential_type", "otp").detail("credential_id", old).success();
      AuthenticatorUtil.logoutOtherSessions(c);
    }
  }
}
