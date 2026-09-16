package io.rareos.auth;

import java.util.Set;
import org.keycloak.authentication.*;
import org.keycloak.authentication.requiredactions.UpdatePassword;
import org.keycloak.models.UserCredentialModel;
import org.keycloak.services.managers.BruteForceProtector;

/** Admin-issued reset emails use the same choice as self-service password recovery. */
public final class ResetPassword extends UpdatePassword {
  private static final String VERIFIED = "rare.reset.mfa.verified";
  @Override public RequiredActionProvider create(org.keycloak.models.KeycloakSession session) { return this; }
  @Override public String getId() { return "RARE_RESET_PASSWORD"; }
  @Override public String getDisplayText() { return "Reset password with authenticator choice"; }
  @Override public InitiatedActionSupport initiatedActionSupport() { return InitiatedActionSupport.NOT_SUPPORTED; }
  @Override public void evaluateTriggers(RequiredActionContext c) { }

  private boolean canChangePassword(RequiredActionContext c) {
    return Devices.otp(c.getUser()).isEmpty() || "true".equals(c.getAuthenticationSession().getAuthNote(VERIFIED));
  }
  @Override public void requiredActionChallenge(RequiredActionContext c) {
    if (canChangePassword(c)) { super.requiredActionChallenge(c); return; }
    c.challenge(c.form().setAttribute("devices", Devices.labels(c.getUser())).createForm("rare-reset-mfa.ftl"));
  }
  @Override public void processAction(RequiredActionContext c) {
    if (canChangePassword(c)) {
      super.processAction(c);
      if (c.getStatus() == RequiredActionContext.Status.SUCCESS) c.getAuthenticationSession().removeAuthNote(VERIFIED);
      return;
    }
    var data = c.getHttpRequest().getDecodedFormParameters();
    String id = data.getFirst("selectedCredentialId");
    if (!Devices.owns(c.getUser(), id)) { error(c, "Select your authenticator device."); return; }
    if ("replace".equals(data.getFirst("choice"))) {
      if (!"yes".equals(data.getFirst("confirmReplace"))) {
        error(c, "Confirm that the selected old authenticator will stop working after replacement."); return;
      }
      c.getAuthenticationSession().setAuthNote(Devices.REPLACE, id);
      c.getAuthenticationSession().addRequiredAction("RARE_REPLACE_OTP");
    } else if ("keep".equals(data.getFirst("choice"))) {
      var guard = c.getSession().getProvider(BruteForceProtector.class);
      var realm = c.getRealm();
      var user = c.getUser();
      if (!user.isEnabled() || (realm.isBruteForceProtected() &&
          (guard.isTemporarilyDisabled(c.getSession(), realm, user) || guard.isPermanentlyLockedOut(c.getSession(), realm, user)))) {
        error(c, "Account temporarily unavailable. Try again later."); return;
      }
      String code = data.getFirst("otp");
      if (code == null || !user.credentialManager().isValid(new UserCredentialModel(id, "otp", code))) {
        if (realm.isBruteForceProtected()) guard.failedLogin(realm, user, c.getSession().getContext().getConnection(), c.getUriInfo(), Set.of("otp"));
        error(c, "Invalid authenticator code."); return;
      }
    } else { error(c, "Choose how to continue."); return; }
    c.getAuthenticationSession().setAuthNote(VERIFIED, "true");
    super.requiredActionChallenge(c);
  }
  private void error(RequiredActionContext c, String message) {
    c.form().setError(message); requiredActionChallenge(c);
  }
}
