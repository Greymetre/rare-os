package io.rareos.auth;
import org.keycloak.authentication.*;
import org.keycloak.authentication.requiredactions.UpdateTotp;
import org.keycloak.events.EventType;
public class ManageMfa extends UpdateTotp {
  @Override public String getId() { return "RARE_MANAGE_MFA"; }
  @Override public String getDisplayText() { return "Manage authenticators"; }
  @Override public int getMaxAuthAge(org.keycloak.models.KeycloakSession session) { return 0; }
  protected boolean disableOnly() { return false; }
  @Override public void requiredActionChallenge(RequiredActionContext c) {
    c.challenge(c.form().setAttribute("devices", Devices.labels(c.getUser())).setAttribute("disableOnly", disableOnly()).setAttribute("mfaRequired", AdminPolicy.required(c.getUser())).createForm("rare-manage-mfa.ftl"));
  }
  @Override public void processAction(RequiredActionContext c) {
    var data = c.getHttpRequest().getDecodedFormParameters();
    String action = data.getFirst("operation");
    if ("cancel".equals(action)) { c.success(); return; }
    if (!"yes".equals(data.getFirst("confirmed"))) {
      c.form().setError("Confirm the change before continuing."); requiredActionChallenge(c); return;
    }
    if ("disable".equals(action) && disableOnly()) {
      if (AdminPolicy.required(c.getUser())) {
        c.form().setError("MFA is required for administrator access and cannot be turned off."); requiredActionChallenge(c); return;
      }
      c.getAuthenticationSession().setUserSessionNote(AdminPolicy.PROOF, "false");
      for (var credential : c.getUser().credentialManager().getStoredCredentialsStream().filter(x -> "otp".equals(x.getType()) || "recovery-authn-codes".equals(x.getType())).toList()) {
        c.getUser().credentialManager().removeStoredCredentialById(credential.getId());
      }
    } else if ("remove".equals(action) && !disableOnly()) {
      String id = data.getFirst("deviceId");
      if (!Devices.owns(c.getUser(), id)) { c.form().setError("Device changed. Refresh and select your device."); requiredActionChallenge(c); return; }
      if (Devices.otp(c.getUser()).size() <= 1) { c.form().setError(AdminPolicy.required(c.getUser()) ? "Administrators must keep at least one authenticator. Add or replace a device before removing this one." : "Use Turn off MFA to remove the last authenticator."); requiredActionChallenge(c); return; }
      c.getUser().credentialManager().removeStoredCredentialById(id);
    } else { c.failure("Invalid security action."); return; }
    c.getEvent().clone().event(EventType.REMOVE_CREDENTIAL).detail("credential_type", "otp").detail("rare_action", action).success();
    AuthenticatorUtil.logoutOtherSessions(c);
    c.success();
  }
}
