package io.rareos.auth;
import org.keycloak.authentication.*;
import org.keycloak.authentication.authenticators.browser.OTPFormAuthenticator;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.models.*;
import jakarta.ws.rs.core.Response;
public final class ResetMfa extends OTPFormAuthenticator {
  @Override public boolean configuredFor(KeycloakSession s, RealmModel r, UserModel u) { return true; }
  @Override public void authenticate(AuthenticationFlowContext c) {
    if (Devices.otp(c.getUser()).isEmpty()) { c.success(); return; }
    c.form().setAttribute("devices", Devices.labels(c.getUser()));
    c.challenge(c.form().createForm("rare-reset-mfa.ftl"));
  }
  @Override protected Response createLoginForm(LoginFormsProvider f) { return f.createForm("rare-reset-mfa.ftl"); }
  @Override public void action(AuthenticationFlowContext c) {
    if (Devices.otp(c.getUser()).isEmpty()) { c.success(); return; }
    c.form().setAttribute("devices", Devices.labels(c.getUser()));
    var data = c.getHttpRequest().getDecodedFormParameters();
    String id = data.getFirst("selectedCredentialId");
    if (!Devices.owns(c.getUser(), id)) {
      c.failureChallenge(AuthenticationFlowError.INVALID_CREDENTIALS, c.form().setError("Select your authenticator device.").createForm("rare-reset-mfa.ftl")); return;
    }
    if ("replace".equals(data.getFirst("choice"))) {
      if (!"yes".equals(data.getFirst("confirmReplace"))) {
        c.challenge(c.form().setError("Confirm that the selected old authenticator will stop working after replacement.").createForm("rare-reset-mfa.ftl")); return;
      }
      // This execution runs only after the reset email has proved mailbox access.
      c.getAuthenticationSession().setAuthNote(Devices.REPLACE, id);
      c.getAuthenticationSession().addRequiredAction("RARE_REPLACE_OTP");
      c.success();
    } else if ("keep".equals(data.getFirst("choice"))) {
      // Reuse Keycloak validation, replay protection and brute-force controls.
      super.validateOTP(c);
    } else {
      c.challenge(c.form().setError("Choose how to continue.").createForm("rare-reset-mfa.ftl"));
    }
  }
}
