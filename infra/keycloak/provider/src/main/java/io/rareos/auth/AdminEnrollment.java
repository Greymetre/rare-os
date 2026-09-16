package io.rareos.auth;
import org.keycloak.authentication.*;
import org.keycloak.authentication.requiredactions.UpdateTotp;
/** Mandatory enrollment is evaluated for every authorization, including an existing SSO login. */
public final class AdminEnrollment extends UpdateTotp {
  @Override public String getId() { return "RARE_ADMIN_MFA"; }
  @Override public String getDisplayText() { return "Required administrator MFA"; }
  @Override public InitiatedActionSupport initiatedActionSupport() { return InitiatedActionSupport.NOT_SUPPORTED; }
  @Override public void evaluateTriggers(RequiredActionContext c) {
    if (AdminPolicy.required(c.getUser()) && Devices.otp(c.getUser()).isEmpty())
      c.getAuthenticationSession().addRequiredAction(getId());
  }
  @Override public void requiredActionChallenge(RequiredActionContext c) {
    if (!Devices.otp(c.getUser()).isEmpty()) { c.success(); return; }
    c.form().setAttribute("rareAdminEnrollment", true).setInfo("MFA is required for your administrator access. Set up an authenticator to continue.");
    super.requiredActionChallenge(c);
  }
  @Override public void processAction(RequiredActionContext c) {
    if (!Devices.otp(c.getUser()).isEmpty()) { c.success(); return; }
    c.form().setAttribute("rareAdminEnrollment", true);
    super.processAction(c);
    if (c.getStatus() == RequiredActionContext.Status.SUCCESS)
      c.getAuthenticationSession().setUserSessionNote(AdminPolicy.PROOF, "true");
  }
}
